/*
    routes/doctors.js

    server.js mounts every file in routes/ by its file name, so this file
    becomes /api/doctors. Paths below are therefore relative:

        GET    /api/doctors?search=&department=&status=&page=&pageSize=
        GET    /api/doctors/:id
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

const express = require("express");

const router = express.Router();

// Same pool server.js uses (config/database.js).
const db = require("../config/database");
const pool = db.pool || db;

// Appointments that still count against a doctor.
const OPEN_STATUSES = ["Booked", "Rescheduled"];

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
    d.years_of_experience          AS years_of_experience,
    d.languages                    AS languages,
    d.consultation_room            AS consultation_room,
    d.photo_url                    AS photo_url,
    (${STATUS_SQL})                AS status,
    (
        SELECT COUNT(*)::int
        FROM appointments a
        WHERE a.doctor_id = d.doctor_id
          AND a.scheduled_at >= now()
          AND a.status = ANY($1::text[])
    )                              AS upcoming_appointments
`;

const DOCTOR_FROM = `
    FROM doctors d
    JOIN departments dep ON dep.id = d.department_id
`;

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

        rows.forEach(row => delete row.total_items);

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

        res.json({ success: true, doctor });
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
            doctor: await findDoctor(req.params.id)
        });
    } catch (error) {
        console.error(error);
        fail(res, 500, "Could not update the doctor.");
    }
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
      AND a.status = ANY($2::text[])
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
          AND a.status = ANY($2::text[])
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
                 AND a.status = ANY($2::text[])
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