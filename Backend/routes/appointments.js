/*
    routes/appointments.js  ->  /api/appointments

        GET   /api/appointments/availability?doctorId=&date=&excludeAppointmentId=
        GET   /api/appointments?search=&status=&department=&doctorId=
                               &dateFrom=&dateTo=&conflict=true&page=&pageSize=
        GET   /api/appointments/:id
        POST  /api/appointments                   create
        PUT   /api/appointments/:id               edit / reschedule
        POST  /api/appointments/:id/cancel        { reason, notifyPatient }
        PATCH /api/appointments/:id/status        { status: Completed | No-show }

    Needs: schedule_tables.sql and appointment_columns.sql run in Neon, and
    lib/slots.js next to the routes/ folder.

    :id is the appointment ID shown on the pages (external_appointment_id),
    or the numeric id of the row.
*/

const express = require("express");

const router = express.Router();

const db = require("../config/database");
const pool = db.pool || db;

const { getSlots, TIME_ZONE } = require("../lib/slots");

const OPEN_STATUSES = ["Booked", "Rescheduled"];
const OPEN_SQL = OPEN_STATUSES.map(s => `'${s}'`).join(", ");

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// How the appointment ID is built from the department's counter
// (department_queue_counters.next_appointment_number): APT-CD-0001.
// Change it here if the group uses another format.
function makeAppointmentId(departmentCode, number) {
    return "APT-" + departmentCode + "-" + String(number).padStart(4, "0");
}

function fail(res, status, message, extra) {
    return res.status(status).json({
        success: false,
        message,
        ...extra
    });
}

// An error the route throws on purpose (shown to the user as is).
class HttpError extends Error {
    constructor(status, message, extra) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function handleError(res, error, fallback) {
    if (error instanceof HttpError) {
        return fail(res, error.status, error.message, error.extra);
    }

    console.error(fallback, error);
    return fail(res, 500, fallback);
}

// ------------------------------------------------------------
// Reading appointments
// ------------------------------------------------------------

// Appointment length of the doctor on the row alias "a".
const SLOT_SQL = `(COALESCE(
        (SELECT h.slot_minutes
         FROM doctor_consultation_hours h
         WHERE h.doctor_id = a.doctor_id
         LIMIT 1), 30) * interval '1 minute')`;

// An open, upcoming appointment that overlaps an OT / leave / other block.
const CONFLICT_SQL = `(
    a.status IN (${OPEN_SQL})
    AND a.scheduled_at >= now()
    AND EXISTS (
        SELECT 1
        FROM doctor_unavailability u
        WHERE u.doctor_id = a.doctor_id
          AND a.scheduled_at <  u.ends_at
          AND a.scheduled_at + ${SLOT_SQL} > u.starts_at
    )
)`;

const FROM_SQL = `
    FROM appointments a
    JOIN patients    p   ON p.id   = a.patient_id
    JOIN departments dep ON dep.id = a.department_id
    LEFT JOIN doctors d  ON d.doctor_id = a.doctor_id
`;

const APPT_COLUMNS = `
    COALESCE(a.external_appointment_id, a.id::text) AS id,
    p.patient_number                                AS patient_id,
    p.full_name                                     AS patient_name,
    p.email                                         AS email,
    NULL::text                                      AS phone,
    dep.department_name                             AS department,
    a.doctor_id                                     AS doctor_id,
    d.full_name                                     AS doctor_name,
    to_char(a.scheduled_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM-DD')
                                                    AS date,
    to_char(a.scheduled_at AT TIME ZONE '${TIME_ZONE}', 'HH24:MI')
                                                    AS time,
    a.status                                        AS status,
    a.notes                                         AS notes,
    NULL::text                                      AS cancel_reason,
    ${CONFLICT_SQL}                                 AS has_conflict
`;

const BY_REF = "(a.external_appointment_id = $1 OR a.id::text = $1)";

async function findAppointment(q, ref) {
    const { rows } = await q.query(
        `SELECT ${APPT_COLUMNS} ${FROM_SQL} WHERE ${BY_REF}`,
        [ref]
    );

    return rows[0] || null;
}

// ------------------------------------------------------------
// GET /availability  (must stay above /:id)
// ------------------------------------------------------------
router.get("/availability", async (req, res) => {
    try {
        const doctorId = (req.query.doctorId || "").trim();
        const date = (req.query.date || "").trim();
        const excludeId = (req.query.excludeAppointmentId || "").trim();

        if (!doctorId || !date) {
            return fail(res, 400, "Doctor ID and date are required.");
        }

        if (!DATE_ONLY.test(date)) {
            return fail(res, 400, "Date must use YYYY-MM-DD format.");
        }

        const { slotMinutes, slots } =
            await getSlots(pool, doctorId, date, excludeId);

        res.json({
            success: true,
            data: { doctorId, date, slotMinutes, slots }
        });
    } catch (error) {
        handleError(res, error, "Failed to retrieve appointment availability.");
    }
});

// ------------------------------------------------------------
// GET /  (list with filters and paging)
// ------------------------------------------------------------
router.get("/", async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(
            100,
            Math.max(1, parseInt(req.query.pageSize, 10) || 20)
        );

        const values = [];
        const where = [];

        const search = (req.query.search || "").trim();

        if (search) {
            values.push("%" + search + "%");
            const n = values.length;

            where.push(
                `(a.external_appointment_id ILIKE $${n}
                  OR a.id::text ILIKE $${n}
                  OR p.full_name ILIKE $${n}
                  OR p.patient_number ILIKE $${n}
                  OR d.full_name ILIKE $${n}
                  OR a.doctor_id ILIKE $${n})`
            );
        }

        if (req.query.status) {
            values.push(req.query.status);
            where.push(`a.status = $${values.length}`);
        }

        if (req.query.department) {
            values.push(req.query.department);
            where.push(`dep.department_name = $${values.length}`);
        }

        if (req.query.doctorId) {
            values.push(req.query.doctorId);
            where.push(`a.doctor_id = $${values.length}`);
        }

        if (DATE_ONLY.test(req.query.dateFrom || "")) {
            values.push(req.query.dateFrom);
            where.push(
                `a.scheduled_at >= (($${values.length}::date)::timestamp
                                    AT TIME ZONE '${TIME_ZONE}')`
            );
        }

        if (DATE_ONLY.test(req.query.dateTo || "")) {
            values.push(req.query.dateTo);
            where.push(
                `a.scheduled_at < (($${values.length}::date + 1)::timestamp
                                   AT TIME ZONE '${TIME_ZONE}')`
            );
        }

        if (req.query.conflict === "true") {
            where.push(CONFLICT_SQL);
        }

        const whereSql = where.length
            ? "WHERE " + where.join(" AND ")
            : "";

        values.push(pageSize, (page - 1) * pageSize);

        const { rows } = await pool.query(
            `SELECT ${APPT_COLUMNS},
                    COUNT(*) OVER() AS total_items
             ${FROM_SQL}
             ${whereSql}
             ORDER BY a.scheduled_at DESC, a.id DESC
             LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values
        );

        const totalItems = rows.length ? Number(rows[0].total_items) : 0;
        rows.forEach(row => delete row.total_items);

        res.json({
            success: true,
            items: rows,
            page,
            pageSize,
            totalItems
        });
    } catch (error) {
        handleError(res, error, "Could not load appointments.");
    }
});

// ------------------------------------------------------------
// GET /:id
// ------------------------------------------------------------
router.get("/:id", async (req, res) => {
    try {
        const appointment = await findAppointment(pool, req.params.id);

        if (!appointment) {
            return fail(res, 404, "Appointment not found.");
        }

        res.json({ success: true, appointment });
    } catch (error) {
        handleError(res, error, "Could not load the appointment.");
    }
});

// ------------------------------------------------------------
// Create and edit
// ------------------------------------------------------------

// Same rules as AMS.validateAppointmentInput in ams.js.
function validateInput(body, editing) {
    const errors = {};
    const data = body || {};

    if (!editing) {
        if (!String(data.patientId || "").trim()) {
            errors.patientId = "Enter the patient ID.";
        }

        if (!String(data.patientName || "").trim()) {
            errors.patientName = "Enter the patient name.";
        }
    }

    if (!data.department) errors.department = "Select a department.";
    if (!data.doctorId) errors.doctorId = "Select a doctor.";

    if (!DATE_ONLY.test(data.date || "")) {
        errors.date = "Select a date.";
    }

    if (!TIME_ONLY.test(data.time || "")) {
        errors.time = "Select a time slot.";
    }

    if (data.email && !EMAIL.test(String(data.email).trim())) {
        errors.email = "Enter a valid email address.";
    }

    return errors;
}

// The department and doctor must exist, the doctor must be active and
// belong to that department.
async function resolveDoctor(q, departmentName, doctorId) {
    const dep = await q.query(
        `SELECT id, department_code
         FROM departments
         WHERE department_name = $1 AND is_active`,
        [departmentName]
    );

    if (!dep.rowCount) {
        throw new HttpError(400, "Select a valid department.");
    }

    const doc = await q.query(
        `SELECT doctor_id, department_id, is_active
         FROM doctors
         WHERE doctor_id = $1`,
        [doctorId]
    );

    if (
        !doc.rowCount ||
        !doc.rows[0].is_active ||
        String(doc.rows[0].department_id) !== String(dep.rows[0].id)
    ) {
        throw new HttpError(
            400,
            "Select an active doctor from the chosen department."
        );
    }

    return {
        departmentId: dep.rows[0].id,
        departmentCode: dep.rows[0].department_code
    };
}

// Two staff booking the same doctor and date at once are queued here,
// so the slot check and the insert cannot both pass.
async function lockDoctorDate(client, doctorId, date) {
    await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        ["appointment:" + doctorId + ":" + date]
    );
}

async function assertSlotFree(client, doctorId, date, time, excludeId) {
    const { slots } = await getSlots(client, doctorId, date, excludeId);
    const slot = slots.find(s => s.time === time);

    if (!slot || slot.state !== "free") {
        throw new HttpError(
            409,
            "That time slot is no longer available. Please pick another one."
        );
    }
}

async function inTransaction(work) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// Next number from the department's counter (the same counter the
// patient-side booking uses, so IDs never repeat).
async function nextAppointmentNumber(client, departmentId) {
    const updated = await client.query(
        `UPDATE department_queue_counters
         SET next_appointment_number = next_appointment_number + 1,
             updated_at = now()
         WHERE department_id = $1
         RETURNING next_appointment_number - 1 AS number`,
        [departmentId]
    );

    if (updated.rowCount) return updated.rows[0].number;

    await client.query(
        `INSERT INTO department_queue_counters
            (department_id, next_number, next_appointment_number, updated_at)
         VALUES ($1, 1, 2, now())`,
        [departmentId]
    );

    return 1;
}

// ------------------------------------------------------------
// POST /  create
// ------------------------------------------------------------
router.post("/", async (req, res) => {
    const errors = validateInput(req.body, false);

    if (Object.keys(errors).length) {
        return fail(res, 400, Object.values(errors)[0], {
            code: "VALIDATION_ERROR",
            details: errors
        });
    }

    try {
        const body = req.body;
        const patientNumber = String(body.patientId).trim();
        const patientName = String(body.patientName).trim();
        const email = String(body.email || "").trim() || null;
        const phone = String(body.phone || "").trim() || null;
        const notes = String(body.notes || "").trim() || null;

        const created = await inTransaction(async client => {
            const { departmentId, departmentCode } =
                await resolveDoctor(client, body.department, body.doctorId);

            await lockDoctorDate(client, body.doctorId, body.date);
            await assertSlotFree(
                client, body.doctorId, body.date, body.time, ""
            );

            // The patient is found by the patient ID. A new ID creates the
            // patient (name and email as typed); an existing patient is
            // left as it is.
            let patient = await client.query(
                "SELECT id FROM patients WHERE patient_number = $1",
                [patientNumber]
            );

            if (!patient.rowCount) {
                patient = await client.query(
                    `INSERT INTO patients
                        (patient_number, full_name, email, is_active,
                         created_at, updated_at)
                     VALUES ($1, $2, $3, true, now(), now())
                     RETURNING id`,
                    [patientNumber, patientName, email]
                );
            }

            const number = await nextAppointmentNumber(client, departmentId);

            const inserted = await client.query(
                `INSERT INTO appointments
                    (external_appointment_id, patient_id, department_id,
                     doctor_id, scheduled_at, status, notes, contact_phone,
                     created_at, updated_at)
                 VALUES ($1, $2, $3, $4,
                         (($5::date + $6::time)::timestamp
                          AT TIME ZONE '${TIME_ZONE}'),
                         'Booked', $7, $8, now(), now())
                 RETURNING external_appointment_id`,
                [
                    makeAppointmentId(departmentCode, number),
                    patient.rows[0].id,
                    departmentId,
                    body.doctorId,
                    body.date,
                    body.time,
                    notes,
                    phone
                ]
            );

            return inserted.rows[0].external_appointment_id;
        });

        res.status(201).json({
            success: true,
            appointment: await findAppointment(pool, created)
        });
    } catch (error) {
        handleError(res, error, "Could not create the appointment.");
    }
});

// ------------------------------------------------------------
// PUT /:id  edit / reschedule
// A Booked appointment whose doctor, date or time changes becomes
// Rescheduled. Closed appointments cannot be changed.
// ------------------------------------------------------------
router.put("/:id", async (req, res) => {
    const errors = validateInput(req.body, true);

    if (Object.keys(errors).length) {
        return fail(res, 400, Object.values(errors)[0], {
            code: "VALIDATION_ERROR",
            details: errors
        });
    }

    try {
        const body = req.body;
        const phone = String(body.phone || "").trim() || null;
        const notes = String(body.notes || "").trim() || null;

        const ref = await inTransaction(async client => {
            const found = await client.query(
                `SELECT a.id,
                        a.external_appointment_id,
                        a.status,
                        a.doctor_id,
                        to_char(a.scheduled_at AT TIME ZONE '${TIME_ZONE}',
                                'YYYY-MM-DD') AS date,
                        to_char(a.scheduled_at AT TIME ZONE '${TIME_ZONE}',
                                'HH24:MI') AS time
                 FROM appointments a
                 WHERE ${BY_REF}
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!found.rowCount) {
                throw new HttpError(404, "Appointment not found.");
            }

            const current = found.rows[0];

            if (!OPEN_STATUSES.includes(current.status)) {
                throw new HttpError(
                    409,
                    "This appointment is " + current.status.toLowerCase() +
                    " and can no longer be changed."
                );
            }

            const { departmentId } =
                await resolveDoctor(client, body.department, body.doctorId);

            const moved =
                current.doctor_id !== body.doctorId ||
                current.date !== body.date ||
                current.time !== body.time;

            if (moved) {
                await lockDoctorDate(client, body.doctorId, body.date);
                await assertSlotFree(
                    client,
                    body.doctorId,
                    body.date,
                    body.time,
                    current.external_appointment_id || String(current.id)
                );
            }

            await client.query(
                `UPDATE appointments
                 SET department_id = $2,
                     doctor_id     = $3,
                     scheduled_at  = (($4::date + $5::time)::timestamp
                                      AT TIME ZONE '${TIME_ZONE}'),
                     status        = $6,
                     notes         = $7,
                     contact_phone = $8,
                     updated_at    = now()
                 WHERE id = $1`,
                [
                    current.id,
                    departmentId,
                    body.doctorId,
                    body.date,
                    body.time,
                    moved && current.status === "Booked"
                        ? "Rescheduled"
                        : current.status,
                    notes,
                    phone
                ]
            );

            return current.external_appointment_id || String(current.id);
        });

        res.json({
            success: true,
            appointment: await findAppointment(pool, ref)
        });
    } catch (error) {
        handleError(res, error, "Could not update the appointment.");
    }
});

// ------------------------------------------------------------
// POST /:id/cancel
// The row stays with status Cancelled so the analytics keep it.
// ------------------------------------------------------------
router.post("/:id/cancel", async (req, res) => {
    try {
        const reason =
            String((req.body && req.body.reason) || "").trim() || null;

        const result = await pool.query(
            `UPDATE appointments a
             SET status = 'Cancelled',
                 cancel_reason = $2,
                 cancelled_at = now(),
                 updated_at = now()
             WHERE ${BY_REF}
               AND a.status IN (${OPEN_SQL})
             RETURNING COALESCE(a.external_appointment_id, a.id::text) AS ref`,
            [req.params.id, reason]
        );

        if (!result.rowCount) {
            const existing = await findAppointment(pool, req.params.id);

            if (!existing) {
                return fail(res, 404, "Appointment not found.");
            }

            return fail(
                res,
                409,
                "This appointment is already " +
                existing.status.toLowerCase() + "."
            );
        }

        res.json({
            success: true,
            appointment: await findAppointment(pool, result.rows[0].ref)
        });
    } catch (error) {
        handleError(res, error, "Could not cancel the appointment.");
    }
});

// ------------------------------------------------------------
// PATCH /:id/status   Completed or No-show, once the time has passed
// ------------------------------------------------------------
router.patch("/:id/status", async (req, res) => {
    try {
        const status = req.body && req.body.status;

        if (status !== "Completed" && status !== "No-show") {
            return fail(res, 400, "Status must be Completed or No-show.");
        }

        const result = await pool.query(
            `UPDATE appointments a
             SET status = $2, updated_at = now()
             WHERE ${BY_REF}
               AND a.status IN (${OPEN_SQL})
               AND a.scheduled_at <= now()
             RETURNING COALESCE(a.external_appointment_id, a.id::text) AS ref`,
            [req.params.id, status]
        );

        if (!result.rowCount) {
            const existing = await findAppointment(pool, req.params.id);

            if (!existing) {
                return fail(res, 404, "Appointment not found.");
            }

            if (!OPEN_STATUSES.includes(existing.status)) {
                return fail(
                    res,
                    409,
                    "This appointment is " + existing.status.toLowerCase() +
                    " already."
                );
            }

            return fail(
                res,
                409,
                "Completed or No-show can only be set once the " +
                "appointment time has passed."
            );
        }

        res.json({
            success: true,
            appointment: await findAppointment(pool, result.rows[0].ref)
        });
    } catch (error) {
        handleError(res, error, "Could not update the appointment.");
    }
});

module.exports = router;