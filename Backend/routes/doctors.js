/*
    routes/doctors.js

    server.js mounts every file in routes/ by its file name, so this file
    becomes /api/doctors. Paths below are therefore relative:

        GET    /api/doctors?search=&department=&status=&page=&pageSize=
        GET    /api/doctors/:id
        POST   /api/doctors                           add a doctor (ID is assigned here)
        PUT    /api/doctors/:id                       edit a doctor
        PUT    /api/doctors/:id/photo                 multipart, field "photo"
        PATCH  /api/doctors/:id/status                { "status": "Active" | "Inactive" }

        GET    /api/doctors/:id/consultation-hours    404 when none saved yet
        PUT    /api/doctors/:id/consultation-hours    { slotMinutes, days: [...] }

        GET    /api/doctors/:id/unavailability?from=YYYY-MM-DD
        POST   /api/doctors/:id/unavailability        { type, from, to, note }
        DELETE /api/doctors/:id/unavailability/:blockId

    Run schedule_tables.sql in Neon first: the schedule routes and the
    "On leave" status read doctor_consultation_hours and
    doctor_unavailability.

    Every doctor is returned in the shape Doctors.js reads:
        id, name, specialty, department, phone, email, photoUrl,
        upcomingAppointments, status (+ the other profile columns).
*/

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const express = require("express");
const multer = require("multer");

const router = express.Router();

// Same pool server.js uses (config/database.js).
const db = require("../config/database");
const pool = db.pool || db;

// Appointments that still count against a doctor (stored, capital
// letters; see lib/status.js).
const { ACTIVE_DB: OPEN_STATUSES } = require("../lib/status");

// Clinic time zone. Dates typed on the pages ("2026-11-10T09:00") have no
// zone, so they are read as clinic time.
const TIME_ZONE = "Asia/Kuala_Lumpur";

const DAYS = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday"
];
const SLOT_LENGTHS = [15, 30, 45, 60];
const DEFAULT_SLOT_MINUTES = 30;
const BLOCK_TYPES = ["OT", "Leave", "Conference", "Other"];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function fail(res, status, message, extra) {
    return res.status(status).json({
        success: false,
        message,
        ...extra
    });
}

function toMinutes(time) {
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

// Status shown on the Doctors page. "On leave" comes from a Leave block
// that is running right now.
const STATUS_SQL = `
    CASE
        WHEN NOT d.is_active THEN 'Inactive'
        WHEN EXISTS (
            SELECT 1
            FROM doctor_unavailability u
            WHERE u.doctor_id = d.doctor_id
              AND u.block_type = 'Leave'
              AND now() >= u.starts_at
              AND now() <  u.ends_at
        ) THEN 'On leave'
        ELSE 'Active'
    END
`;

// Appointment length of a doctor (minutes as an interval).
function slotInterval(doctorRef) {
    return `(COALESCE(
        (SELECT h.slot_minutes
         FROM doctor_consultation_hours h
         WHERE h.doctor_id = ${doctorRef}
         LIMIT 1),
        ${DEFAULT_SLOT_MINUTES}) * interval '1 minute')`;
}

const DOCTOR_COLUMNS = `
    d.doctor_id                    AS id,
    d.full_name                    AS name,
    d.specialty                    AS specialty,
    dep.department_name            AS department,
    d.phone                        AS phone,
    d.email                        AS email,
    d.qualifications               AS qualifications,
    d.years_of_experience          AS experience_years,
    d.languages                    AS languages,
    d.consultation_room            AS room,
    d.photo_url                    AS photo_url,
    d.bio                          AS bio,
    (${STATUS_SQL})                AS status,
    (
        SELECT COUNT(*)::int
        FROM appointments a
        WHERE a.doctor_id = d.doctor_id
          AND a.scheduled_at >= now()
          AND UPPER(a.status) = ANY($1::text[])
    )                              AS upcoming_appointments
`;

const DOCTOR_FROM = `
    FROM doctors d
    JOIN departments dep ON dep.id = d.department_id
`;

class HttpError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

// Photos saved by this server are stored as /uploads/doctors/<file>.
// The pages get a full address, like the Cloudinary photos already in the
// table, so they load from any port.
const PHOTO_PREFIX = "/uploads/doctors/";

function present(req, doctor) {
    if (doctor && doctor.photo_url && doctor.photo_url.startsWith(PHOTO_PREFIX)) {
        const origin =
            process.env.PUBLIC_API_URL ||
            req.protocol + "://" + req.get("host");

        doctor.photo_url = origin + doctor.photo_url;
    }

    return doctor;
}

// ------------------------------------------------------------
// GET /api/doctors
// ------------------------------------------------------------
router.get("/", async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(
            100,
            Math.max(1, parseInt(req.query.pageSize, 10) || 20)
        );

        // $1 is the list of open appointment statuses (used in the
        // upcoming_appointments sub-query), filters start at $2.
        const values = [OPEN_STATUSES];
        const where = [];

        const search = (req.query.search || "").trim();

        if (search) {
            values.push("%" + search + "%");
            where.push(
                `(d.full_name ILIKE $${values.length}
                  OR d.doctor_id ILIKE $${values.length})`
            );
        }

        if (req.query.department) {
            values.push(req.query.department);
            where.push(`dep.department_name = $${values.length}`);
        }

        if (["Active", "On leave", "Inactive"].includes(req.query.status)) {
            values.push(req.query.status);
            where.push(`(${STATUS_SQL}) = $${values.length}`);
        }

        const whereSql = where.length
            ? "WHERE " + where.join(" AND ")
            : "";

        values.push(pageSize, (page - 1) * pageSize);

        const { rows } = await pool.query(
            `SELECT ${DOCTOR_COLUMNS},
                    COUNT(*) OVER() AS total_items
             ${DOCTOR_FROM}
             ${whereSql}
             ORDER BY d.full_name
             LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values
        );

        // COUNT(*) OVER() is a bigint, which pg returns as a string.
        const totalItems = rows.length
            ? Number(rows[0].total_items)
            : 0;

        rows.forEach(row => {
            delete row.total_items;
            present(req, row);
        });

        res.json({
            success: true,
            items: rows,
            page,
            pageSize,
            totalItems
        });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not load doctors.");
    }
});

async function findDoctor(id) {
    const { rows } = await pool.query(
        `SELECT ${DOCTOR_COLUMNS}
         ${DOCTOR_FROM}
         WHERE d.doctor_id = $2`,
        [OPEN_STATUSES, id]
    );

    return rows[0] || null;
}

async function doctorExists(id) {
    const { rowCount } = await pool.query(
        "SELECT 1 FROM doctors WHERE doctor_id = $1",
        [id]
    );

    return rowCount > 0;
}

// ------------------------------------------------------------
// GET /api/doctors/:id
// ------------------------------------------------------------
router.get("/:id", async (req, res) => {
    try {
        const doctor = await findDoctor(req.params.id);

        if (!doctor) {
            return fail(res, 404, "Doctor not found.");
        }

        res.json({ success: true, doctor: present(req, doctor) });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not load the doctor.");
    }
});

// ------------------------------------------------------------
// PATCH /api/doctors/:id/status
// Doctors are deactivated, never deleted, so old appointments
// keep their doctor. Deactivating is refused while the doctor
// still has upcoming appointments.
// ------------------------------------------------------------
router.patch("/:id/status", async (req, res) => {
    try {
        const status = req.body && req.body.status;

        if (status !== "Active" && status !== "Inactive") {
            return fail(
                res,
                400,
                "Status must be Active or Inactive. " +
                "On leave is set by adding a Leave block."
            );
        }

        const doctor = await findDoctor(req.params.id);

        if (!doctor) {
            return fail(res, 404, "Doctor not found.");
        }

        if (status === "Inactive" && doctor.upcoming_appointments > 0) {
            return fail(
                res,
                409,
                doctor.name + " still has upcoming appointments.",
                {
                    code: "UPCOMING_APPOINTMENTS",
                    upcomingAppointments: doctor.upcoming_appointments
                }
            );
        }

        await pool.query(
            `UPDATE doctors
             SET is_active = $1, updated_at = now()
             WHERE doctor_id = $2`,
            [status === "Active", req.params.id]
        );

        res.json({
            success: true,
            doctor: present(req, await findDoctor(req.params.id))
        });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not update the doctor.");
    }
});

// ============================================================
// ADD AND EDIT A DOCTOR
// ============================================================

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same rules as AMS.validateDoctorInput in ams.js, plus the number check.
function readDoctorInput(body) {
    const data = body || {};
    const text = value => String(value === undefined || value === null ? "" : value).trim();

    const input = {
        name: text(data.name),
        department: text(data.department),
        specialty: text(data.specialty),
        phone: text(data.phone),
        email: text(data.email),
        qualifications: text(data.qualifications) || null,
        languages: text(data.languages),
        room: text(data.room),
        bio: text(data.bio) || null,
        status: data.status === undefined ? undefined : text(data.status),
        years: null
    };

    const errors = {};

    if (!input.name) errors.name = "Enter the doctor's name.";
    if (!input.department) errors.department = "Select a department.";
    if (!input.specialty) errors.specialty = "Enter the specialty.";
    if (!input.phone) errors.phone = "Enter a phone number.";

    if (!EMAIL.test(input.email)) {
        errors.email = "Enter a valid email address.";
    }

    if (data.experienceYears !== undefined && data.experienceYears !== null && data.experienceYears !== "") {
        const years = Number(data.experienceYears);

        if (!Number.isInteger(years) || years < 0 || years > 60) {
            errors.experienceYears = "Experience must be a whole number from 0 to 60.";
        } else {
            input.years = years;
        }
    }

    if (
        input.status !== undefined &&
        !["Active", "On leave", "Inactive"].includes(input.status)
    ) {
        errors.status = "Choose a valid status.";
    }

    if (input.name.length > 150 || input.specialty.length > 150 || input.email.length > 150) {
        errors.name = "A value is too long.";
    }

    return { input, errors };
}

function validationFailure(res, errors) {
    return fail(res, 400, Object.values(errors)[0], {
        code: "VALIDATION_ERROR",
        details: errors
    });
}

async function findDepartment(q, name) {
    const { rows } = await q.query(
        `SELECT id, department_code
         FROM departments
         WHERE department_name = $1 AND is_active`,
        [name]
    );

    if (!rows.length) {
        throw new HttpError(400, "Select a valid department.");
    }

    return rows[0];
}

// DOC-<department code>-<three digits>, next free number for that code.
async function nextDoctorId(client, departmentCode) {
    const code = String(departmentCode).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const prefix = "DOC-" + code + "-";

    await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        ["doctor-id:" + prefix]
    );

    const { rows } = await client.query(
        `SELECT COALESCE(
                    MAX(substring(doctor_id FROM '([0-9]+)$')::bigint), 0
                ) + 1 AS next
         FROM doctors
         WHERE starts_with(doctor_id, $1)`,
        [prefix]
    );

    return prefix + String(rows[0].next).padStart(3, "0");
}

function handleDoctorError(res, error, fallback) {
    if (error instanceof HttpError) {
        return fail(res, error.status, error.message, error.extra);
    }

    // unique constraint (e-mail or doctor ID already used)
    if (error && error.code === "23505") {
        return fail(
            res,
            409,
            "A doctor with this email address already exists."
        );
    }

    console.error(fallback, error);
    return fail(res, 500, fallback);
}

// ------------------------------------------------------------
// POST /api/doctors
// ------------------------------------------------------------
router.post("/", async (req, res) => {
    const { input, errors } = readDoctorInput(req.body);

    if (Object.keys(errors).length) {
        return validationFailure(res, errors);
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const department = await findDepartment(client, input.department);
        const doctorId = await nextDoctorId(client, department.department_code);

        // "On leave" is not stored: it follows from a Leave block, so a
        // new doctor is active unless Inactive was chosen.
        await client.query(
            `INSERT INTO doctors
                (doctor_id, full_name, department_id, specialty, phone, email,
                 qualifications, years_of_experience, languages,
                 consultation_room, is_active, bio, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     now(), now())`,
            [
                doctorId,
                input.name,
                department.id,
                input.specialty,
                input.phone,
                input.email,
                input.qualifications,
                input.years === null ? 0 : input.years,
                input.languages,
                input.room,
                input.status !== "Inactive",
                input.bio
            ]
        );

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            doctor: present(req, await findDoctor(doctorId))
        });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        handleDoctorError(res, error, "Could not add the doctor.");
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------
// PUT /api/doctors/:id
// ------------------------------------------------------------
router.put("/:id", async (req, res) => {
    const { input, errors } = readDoctorInput(req.body);

    if (Object.keys(errors).length) {
        return validationFailure(res, errors);
    }

    try {
        const current = await findDoctor(req.params.id);

        if (!current) {
            return fail(res, 404, "Doctor not found.");
        }

        const department = await findDepartment(pool, input.department);

        // Same rule as PATCH /:id/status: no deactivating while the doctor
        // still has upcoming appointments. "On leave" cannot be set here;
        // an active doctor stays active.
        let isActive = current.status !== "Inactive";

        if (input.status === "Inactive") {
            if (isActive && current.upcoming_appointments > 0) {
                return fail(
                    res,
                    409,
                    current.name + " still has upcoming appointments.",
                    {
                        code: "UPCOMING_APPOINTMENTS",
                        upcomingAppointments: current.upcoming_appointments
                    }
                );
            }

            isActive = false;
        } else if (input.status === "Active" || input.status === "On leave") {
            isActive = true;
        }

        await pool.query(
            `UPDATE doctors
             SET full_name           = $2,
                 department_id       = $3,
                 specialty           = $4,
                 phone               = $5,
                 email               = $6,
                 qualifications      = $7,
                 years_of_experience = $8,
                 languages           = $9,
                 consultation_room   = $10,
                 bio                 = $11,
                 is_active           = $12,
                 updated_at          = now()
             WHERE doctor_id = $1`,
            [
                req.params.id,
                input.name,
                department.id,
                input.specialty,
                input.phone,
                input.email,
                input.qualifications,
                input.years === null ? 0 : input.years,
                input.languages,
                input.room,
                input.bio,
                isActive
            ]
        );

        res.json({
            success: true,
            doctor: present(req, await findDoctor(req.params.id))
        });
    } catch (error) {
        handleDoctorError(res, error, "Could not update the doctor.");
    }
});

// ------------------------------------------------------------
// PUT /api/doctors/:id/photo   (multipart, field "photo")
// The image is uploaded to Cloudinary and photo_url stores the full
// https link, so the admin pages and the booking side load the same URL.
// Only real JPEG, PNG and WebP images up to 2 MB are accepted.
// ------------------------------------------------------------
const cloudinary = require("../config/cloudinary");

// Photos saved before the move to Cloudinary are in this folder.
// It is only used to delete an old local photo when it is replaced.
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "doctors");

const IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp"
};

// Checks the first bytes of the file, not just the name or the
// type the browser claims.
function looksLikeImage(buffer) {
    const head = buffer.subarray(0, 12);

    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    const webp =
        head.subarray(0, 4).toString("ascii") === "RIFF" &&
        head.subarray(8, 12).toString("ascii") === "WEBP";

    return jpeg || png || webp;
}

const photoUpload = multer({
    storage: multer.memoryStorage(),          // nothing is written to disk
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (IMAGE_TYPES[file.mimetype]) return cb(null, true);

        cb(new HttpError(400, "The photo must be a JPEG, PNG or WebP image."));
    }
});

function uploadToCloudinary(buffer, doctorId) {
    return new Promise((resolve, reject) => {
        cloudinary.uploader
            .upload_stream(
                {
                    folder: "hospital/doctors",
                    public_id: doctorId,       // one photo per doctor, replaced on re-upload
                    overwrite: true,
                    invalidate: true,
                    resource_type: "image",
                    transformation: [
                        { width: 400, height: 400, crop: "fill", gravity: "auto" }
                    ]
                },
                (error, result) => (error ? reject(error) : resolve(result))
            )
            .end(buffer);
    });
}

function removeStoredPhoto(photoUrl) {
    if (!photoUrl || !photoUrl.startsWith(PHOTO_PREFIX)) return;

    // path.basename keeps the delete inside the upload folder.
    fs.unlink(
        path.join(UPLOAD_DIR, path.basename(photoUrl)),
        () => {}
    );
}

router.put("/:id/photo", (req, res) => {
    photoUpload.single("photo")(req, res, async uploadError => {
        const file = req.file;

        try {
            if (uploadError) {
                if (uploadError.code === "LIMIT_FILE_SIZE") {
                    throw new HttpError(400, "The photo must be 2 MB or smaller.");
                }

                if (uploadError instanceof HttpError) throw uploadError;

                throw new HttpError(400, "The photo could not be uploaded.");
            }

            if (!file) {
                throw new HttpError(400, "Choose a photo to upload.");
            }

            if (!looksLikeImage(file.buffer)) {
                throw new HttpError(400, "That file is not a valid image.");
            }

            const current = await findDoctor(req.params.id);

            if (!current) {
                throw new HttpError(404, "Doctor not found.");
            }

            const uploaded = await uploadToCloudinary(file.buffer, req.params.id);

            await pool.query(
                `UPDATE doctors
                 SET photo_url = $2, updated_at = now()
                 WHERE doctor_id = $1`,
                [req.params.id, uploaded.secure_url]
            );

            // Only deletes an old local /uploads/doctors file, never a Cloudinary link.
            removeStoredPhoto(current.photo_url);

            res.json({
                success: true,
                doctor: present(req, await findDoctor(req.params.id))
            });
        } catch (error) {
            handleDoctorError(res, error, "Could not save the photo.");
        }
    });
});


// ============================================================
// WEEKLY CONSULTATION HOURS
// ============================================================

function sessionOf(start, end) {
    return start && end ? { start, end } : null;
}

function buildHours(rows) {
    return {
        slotMinutes: rows.length
            ? rows[0].slot_minutes
            : DEFAULT_SLOT_MINUTES,
        days: DAYS.map((day, index) => {
            const row = rows.find(r => r.day_of_week === index + 1);

            if (!row) {
                return {
                    day,
                    working: false,
                    morning: null,
                    afternoon: null
                };
            }

            return {
                day,
                working: row.is_working,
                morning: sessionOf(row.morning_start, row.morning_end),
                afternoon: sessionOf(
                    row.afternoon_start,
                    row.afternoon_end
                )
            };
        })
    };
}

// Same rules as AMS.validateConsultationHours in ams.js.
function validateHours(body) {
    const errors = [];

    if (
        !body ||
        !SLOT_LENGTHS.includes(Number(body.slotMinutes)) ||
        !Array.isArray(body.days)
    ) {
        errors.push({
            day: null,
            session: null,
            message: "Choose a valid appointment length."
        });

        return errors;
    }

    const seen = new Set();

    body.days.forEach(item => {
        if (!item || !DAYS.includes(item.day) || seen.has(item.day)) {
            errors.push({
                day: null,
                session: null,
                message: "Each weekday must appear once."
            });

            return;
        }

        seen.add(item.day);

        if (!item.working) return;

        const morning = item.morning || null;
        const afternoon = item.afternoon || null;

        if (!morning && !afternoon) {
            errors.push({
                day: item.day,
                session: "morning",
                message:
                    "Add at least one session, " +
                    "or mark the day as not working."
            });

            return;
        }

        let morningOk = true;
        let afternoonOk = true;

        [["morning", morning], ["afternoon", afternoon]]
            .forEach(([label, session]) => {
                if (!session) return;

                let ok = true;

                if (
                    !TIME_PATTERN.test(session.start || "") ||
                    !TIME_PATTERN.test(session.end || "")
                ) {
                    errors.push({
                        day: item.day,
                        session: label,
                        message: "Enter both start and end, or clear both."
                    });

                    ok = false;
                } else if (
                    toMinutes(session.end) <= toMinutes(session.start)
                ) {
                    errors.push({
                        day: item.day,
                        session: label,
                        message: "End must be after start."
                    });

                    ok = false;
                }

                if (label === "morning") morningOk = ok;
                else afternoonOk = ok;
            });

        if (
            morning && afternoon && morningOk && afternoonOk &&
            toMinutes(afternoon.start) < toMinutes(morning.end)
        ) {
            errors.push({
                day: item.day,
                session: "afternoon",
                message: "Afternoon must start after the morning ends."
            });
        }
    });

    if (seen.size !== DAYS.length && !errors.length) {
        errors.push({
            day: null,
            session: null,
            message: "Each weekday must appear once."
        });
    }

    return errors;
}

// Open future appointments that no longer fall inside the doctor's
// saved hours (a slot must start and end inside a session).
const OUTSIDE_HOURS_SQL = `
    SELECT COALESCE(a.external_appointment_id, a.id::text) AS id,
           a.scheduled_at
    FROM appointments a
    WHERE a.doctor_id = $1
      AND UPPER(a.status) = ANY($2::text[])
      AND a.scheduled_at >= now()
      AND NOT EXISTS (
          SELECT 1
          FROM doctor_consultation_hours h
          WHERE h.doctor_id = a.doctor_id
            AND h.is_working
            AND h.day_of_week = EXTRACT(
                    ISODOW FROM a.scheduled_at AT TIME ZONE '${TIME_ZONE}'
                )::int
            AND (
                (h.morning_start IS NOT NULL
                 AND (a.scheduled_at AT TIME ZONE '${TIME_ZONE}')::time
                        >= h.morning_start
                 AND (a.scheduled_at AT TIME ZONE '${TIME_ZONE}')::time
                        + (h.slot_minutes * interval '1 minute')
                        <= h.morning_end)
                OR
                (h.afternoon_start IS NOT NULL
                 AND (a.scheduled_at AT TIME ZONE '${TIME_ZONE}')::time
                        >= h.afternoon_start
                 AND (a.scheduled_at AT TIME ZONE '${TIME_ZONE}')::time
                        + (h.slot_minutes * interval '1 minute')
                        <= h.afternoon_end)
            )
      )
    ORDER BY a.scheduled_at
`;

router.get("/:id/consultation-hours", async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT day_of_week,
                    is_working,
                    slot_minutes,
                    to_char(morning_start,   'HH24:MI') AS morning_start,
                    to_char(morning_end,     'HH24:MI') AS morning_end,
                    to_char(afternoon_start, 'HH24:MI') AS afternoon_start,
                    to_char(afternoon_end,   'HH24:MI') AS afternoon_end
             FROM doctor_consultation_hours
             WHERE doctor_id = $1
             ORDER BY day_of_week`,
            [req.params.id]
        );

        // The page shows its default hours when it gets a 404.
        if (!rows.length) {
            return fail(
                res,
                404,
                "No consultation hours are saved for this doctor yet."
            );
        }

        res.json({ success: true, hours: buildHours(rows) });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not load consultation hours.");
    }
});

router.put("/:id/consultation-hours", async (req, res) => {
    const errors = validateHours(req.body);

    if (errors.length) {
        return fail(
            res,
            400,
            errors[0].message,
            { code: "VALIDATION_ERROR", details: errors }
        );
    }

    let client;

    try {
        if (!(await doctorExists(req.params.id))) {
            return fail(res, 404, "Doctor not found.");
        }

        client = await pool.connect();
        await client.query("BEGIN");

        for (const item of req.body.days) {
            const working = Boolean(item.working);
            const morning = working ? item.morning : null;
            const afternoon = working ? item.afternoon : null;

            await client.query(
                `INSERT INTO doctor_consultation_hours
                    (doctor_id, day_of_week, is_working, slot_minutes,
                     morning_start, morning_end,
                     afternoon_start, afternoon_end, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
                 ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
                    is_working      = EXCLUDED.is_working,
                    slot_minutes    = EXCLUDED.slot_minutes,
                    morning_start   = EXCLUDED.morning_start,
                    morning_end     = EXCLUDED.morning_end,
                    afternoon_start = EXCLUDED.afternoon_start,
                    afternoon_end   = EXCLUDED.afternoon_end,
                    updated_at      = now()`,
                [
                    req.params.id,
                    DAYS.indexOf(item.day) + 1,
                    working,
                    Number(req.body.slotMinutes),
                    morning ? morning.start : null,
                    morning ? morning.end : null,
                    afternoon ? afternoon.start : null,
                    afternoon ? afternoon.end : null
                ]
            );
        }

        const saved = await client.query(
            `SELECT day_of_week, is_working, slot_minutes,
                    to_char(morning_start,   'HH24:MI') AS morning_start,
                    to_char(morning_end,     'HH24:MI') AS morning_end,
                    to_char(afternoon_start, 'HH24:MI') AS afternoon_start,
                    to_char(afternoon_end,   'HH24:MI') AS afternoon_end
             FROM doctor_consultation_hours
             WHERE doctor_id = $1
             ORDER BY day_of_week`,
            [req.params.id]
        );

        const affected = await client.query(
            OUTSIDE_HOURS_SQL,
            [req.params.id, OPEN_STATUSES]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            data: {
                hours: buildHours(saved.rows),
                affectedAppointments: affected.rows
            }
        });
    } catch (error) {
        if (client) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error(error);
        fail(res, 500, "Could not save consultation hours.");
    } finally {
        if (client) client.release();
    }
});

// ============================================================
// OT, LEAVE AND OTHER BLOCKS
// ============================================================

// Open appointments that overlap a block (the appointment runs for the
// doctor's slot length).
function blockAffectedSql(doctorRef, startRef, endRef) {
    return `
        SELECT COALESCE(a.external_appointment_id, a.id::text) AS id,
               a.scheduled_at
        FROM appointments a
        WHERE a.doctor_id = ${doctorRef}
          AND UPPER(a.status) = ANY($2::text[])
          AND a.scheduled_at >= now()
          AND a.scheduled_at <  ${endRef}
          AND a.scheduled_at + ${slotInterval(doctorRef)} > ${startRef}
        ORDER BY a.scheduled_at
    `;
}

const BLOCK_SELECT = `
    SELECT u.id,
           u.block_type AS type,
           u.starts_at  AS "from",
           u.ends_at    AS "to",
           u.note,
           (
               SELECT COUNT(*)::int
               FROM appointments a
               WHERE a.doctor_id = u.doctor_id
                 AND UPPER(a.status) = ANY($2::text[])
                 AND a.scheduled_at >= now()
                 AND a.scheduled_at <  u.ends_at
                 AND a.scheduled_at + ${slotInterval("u.doctor_id")}
                         > u.starts_at
           ) AS affected_appointments
    FROM doctor_unavailability u
`;

router.get("/:id/unavailability", async (req, res) => {
    try {
        const values = [req.params.id, OPEN_STATUSES];
        let fromSql = "";

        // ?from=2026-11-04 hides blocks that already ended.
        if (DATE_ONLY.test(req.query.from || "")) {
            values.push(req.query.from);
            fromSql =
                `AND u.ends_at >= (($3::date)::timestamp
                                   AT TIME ZONE '${TIME_ZONE}')`;
        }

        const { rows } = await pool.query(
            `${BLOCK_SELECT}
             WHERE u.doctor_id = $1 ${fromSql}
             ORDER BY u.starts_at`,
            values
        );

        res.json({ success: true, items: rows });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not load unavailable times.");
    }
});

router.post("/:id/unavailability", async (req, res) => {
    try {
        const body = req.body || {};
        const type = body.type;
        const from = body.from;
        const to = body.to;
        const note = (body.note || "").toString().trim() || null;

        if (!BLOCK_TYPES.includes(type)) {
            return fail(res, 400, "Choose a type.");
        }

        if (!LOCAL_DATETIME.test(from || "") || !LOCAL_DATETIME.test(to || "")) {
            return fail(res, 400, "Enter the from and to date and time.");
        }

        if (new Date(to) <= new Date(from)) {
            return fail(res, 400, "The end must be after the start.");
        }

        if (!(await doctorExists(req.params.id))) {
            return fail(res, 404, "Doctor not found.");
        }

        const overlap = await pool.query(
            `SELECT 1
             FROM doctor_unavailability
             WHERE doctor_id = $1
               AND starts_at < ($3::timestamp AT TIME ZONE '${TIME_ZONE}')
               AND ends_at   > ($2::timestamp AT TIME ZONE '${TIME_ZONE}')
             LIMIT 1`,
            [req.params.id, from, to]
        );

        if (overlap.rowCount) {
            return fail(
                res,
                409,
                "This overlaps an existing block for this doctor.",
                { code: "BLOCK_OVERLAP" }
            );
        }

        const inserted = await pool.query(
            `INSERT INTO doctor_unavailability
                (doctor_id, block_type, starts_at, ends_at, note)
             VALUES ($1, $2,
                     $3::timestamp AT TIME ZONE '${TIME_ZONE}',
                     $4::timestamp AT TIME ZONE '${TIME_ZONE}',
                     $5)
             RETURNING id, starts_at, ends_at`,
            [req.params.id, type, from, to, note]
        );

        const saved = inserted.rows[0];

        const affected = await pool.query(
            blockAffectedSql("$1", "$3::timestamptz", "$4::timestamptz"),
            [
                req.params.id,
                OPEN_STATUSES,
                saved.starts_at,
                saved.ends_at
            ]
        );

        res.status(201).json({
            success: true,
            data: {
                block: {
                    id: saved.id,
                    type,
                    from: saved.starts_at,
                    to: saved.ends_at,
                    note,
                    affected_appointments: affected.rowCount
                },
                affectedAppointments: affected.rows
            }
        });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not add the unavailable time.");
    }
});

router.delete("/:id/unavailability/:blockId", async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.blockId)) {
            return fail(res, 400, "Invalid block.");
        }

        const result = await pool.query(
            `DELETE FROM doctor_unavailability
             WHERE id = $1 AND doctor_id = $2`,
            [req.params.blockId, req.params.id]
        );

        if (!result.rowCount) {
            return fail(res, 404, "Block not found.");
        }

        res.json({ success: true, message: "Block removed." });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not remove the block.");
    }
});

module.exports = router;