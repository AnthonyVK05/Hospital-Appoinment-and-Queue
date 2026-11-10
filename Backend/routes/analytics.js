/*
    routes/analytics.js  ->  /api/analytics

    Written for the pages AppointmentDemand.html, PeakPeriods.html and
    DoctorUtilisation.html (the calls in ams.js):

        GET /api/analytics/appointment-demand?dateFrom=&dateTo=&department=&groupBy=day|week
        GET /api/analytics/peak-periods?dateFrom=&dateTo=&department=&doctorId=
        GET /api/analytics/doctor-utilisation?dateFrom=&dateTo=&department=
        GET /api/analytics/cancellations              (unchanged, see the end)

    dateFrom and dateTo are clinic-time dates (YYYY-MM-DD), both included.
    department is the department NAME. Appointments count on the day and
    hour they are scheduled for, in Asia/Kuala_Lumpur time.

    Demand and peak periods count every appointment that is not cancelled
    (Booked, Rescheduled, Checked In, Completed, No-show), as the page
    notes say. Utilisation uses the doctors' consultation hours
    (doctor_consultation_hours, or the ams.js defaults when none are saved)
    and OT / leave blocks (doctor_unavailability).
*/

const express = require("express");

const router = express.Router();

const db = require("../config/database");
const pool = db.pool || db;

const {
    TIME_ZONE,
    DEFAULT_DAYS,
    DEFAULT_SLOT_MINUTES,
    toMinutes
} = require("../lib/slots");

const TZ = `'${TIME_ZONE}'`;

// Asia/Kuala_Lumpur has no daylight saving, so one fixed offset is enough
// to turn a clinic date and time into a moment.
const OFFSET = "+08:00";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

const IS_CANCELLED = "UPPER(a.status) IN ('CANCELLED', 'CANCELED')";
const LOCAL_DAY = `(a.scheduled_at AT TIME ZONE ${TZ})`;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function handleError(res, error, fallback) {
    if (error instanceof HttpError) {
        return res.status(error.status).json({
            success: false,
            message: error.message
        });
    }

    console.error(fallback, error);

    res.status(500).json({ success: false, message: fallback });
}

// dateFrom / dateTo are required and checked here.
function readPeriod(query) {
    const dateFrom = String(query.dateFrom || "").trim();
    const dateTo = String(query.dateTo || "").trim();

    if (!DATE_ONLY.test(dateFrom) || !DATE_ONLY.test(dateTo)) {
        throw new HttpError(400, "dateFrom and dateTo must use YYYY-MM-DD.");
    }

    const from = Date.parse(dateFrom + "T00:00:00Z");
    const to = Date.parse(dateTo + "T00:00:00Z");

    if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
        throw new HttpError(400, "dateTo must not be before dateFrom.");
    }

    const days = Math.round((to - from) / DAY_MS) + 1;

    if (days > MAX_DAYS) {
        throw new HttpError(400, "Choose a period of up to one year.");
    }

    return {
        dateFrom,
        dateTo,
        days,
        department: String(query.department || "").trim() || null,
        doctorId: String(query.doctorId || "").trim() || null
    };
}

// ------------------------------------------------------------
// Appointment demand
// ------------------------------------------------------------

// base = every non-cancelled appointment of the period and of the equally
// long period just before it (for "vs previous period"). $1 dateFrom,
// $2 dateTo, $3 department name or null.
const DEMAND_BASE = `
    WITH p AS (
        SELECT $1::date AS d_from,
               $2::date AS d_to,
               ($2::date - $1::date + 1) AS n
    ),
    base AS (
        SELECT a.id, a.doctor_id, a.department_id,
               ${LOCAL_DAY}::date AS day
        FROM appointments a, p
        WHERE NOT ${IS_CANCELLED}
          AND ${LOCAL_DAY}::date BETWEEN p.d_from - p.n AND p.d_to
          AND ($3::text IS NULL
               OR a.department_id IN (
                   SELECT id FROM departments
                   WHERE department_name = $3::text))
    )
`;

router.get("/appointment-demand", async (req, res) => {
    try {
        const period = readPeriod(req.query);
        const weekly = req.query.groupBy === "week";

        const values = [
            period.dateFrom,
            period.dateTo,
            period.department
        ];

        const trendSql = weekly
            ? `${DEMAND_BASE}
               SELECT to_char(p.d_from + w.i * 7, 'YYYY-MM-DD') AS date,
                      to_char(p.d_from + w.i * 7, 'DD Mon')     AS label,
                      COUNT(b.id)::int                          AS count
               FROM p
               CROSS JOIN generate_series(0, (p.n - 1) / 7) AS w(i)
               LEFT JOIN base b
                      ON b.day >= p.d_from + w.i * 7
                     AND b.day <  p.d_from + w.i * 7 + 7
                     AND b.day <= p.d_to
               GROUP BY w.i, p.d_from
               ORDER BY w.i`
            : `${DEMAND_BASE}
               SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
                      COUNT(b.id)::int             AS count
               FROM p
               CROSS JOIN generate_series(p.d_from, p.d_to,
                                          interval '1 day') AS g(day)
               LEFT JOIN base b ON b.day = g.day::date
               GROUP BY g.day
               ORDER BY g.day`;

        const [totals, trend, byDepartment, byDoctor] = await Promise.all([
            pool.query(
                `${DEMAND_BASE}
                 SELECT COUNT(*) FILTER (WHERE b.day >= p.d_from)::int
                            AS total,
                        COUNT(*) FILTER (WHERE b.day <  p.d_from)::int
                            AS previous_total
                 FROM base b CROSS JOIN p`,
                values
            ),

            pool.query(trendSql, values),

            pool.query(
                `${DEMAND_BASE}
                 SELECT dep.department_name AS name,
                        COUNT(*)::int       AS count
                 FROM base b
                 CROSS JOIN p
                 JOIN departments dep ON dep.id = b.department_id
                 WHERE b.day >= p.d_from
                 GROUP BY dep.department_name
                 ORDER BY count DESC, dep.department_name`,
                values
            ),

            // A doctor ID that is not in the doctors table (or empty) is
            // still shown, by the ID, so no appointment is hidden.
            pool.query(
                `${DEMAND_BASE}
                 SELECT COALESCE(b.doctor_id, '')                 AS doctor_id,
                        COALESCE(d.full_name, b.doctor_id, 'Unassigned')
                                                                  AS doctor_name,
                        COALESCE(ddep.department_name,
                                 MIN(dep.department_name))        AS department,
                        COUNT(*) FILTER (WHERE b.day >= p.d_from)::int
                                                                  AS count,
                        COUNT(*) FILTER (WHERE b.day <  p.d_from)::int
                                                                  AS previous_count
                 FROM base b
                 CROSS JOIN p
                 LEFT JOIN doctors     d    ON d.doctor_id = b.doctor_id
                 LEFT JOIN departments ddep ON ddep.id = d.department_id
                 LEFT JOIN departments dep  ON dep.id = b.department_id
                 GROUP BY b.doctor_id, d.full_name, ddep.department_name
                 HAVING COUNT(*) FILTER (WHERE b.day >= p.d_from) > 0
                 ORDER BY count DESC, doctor_name`,
                values
            )
        ]);

        const total = totals.rows[0].total;

        res.json({
            success: true,
            data: {
                total,
                previousTotal: totals.rows[0].previous_total,
                averagePerDay: total / period.days,
                trend: trend.rows,
                byDepartment: byDepartment.rows,
                byDoctor: byDoctor.rows
            }
        });
    } catch (error) {
        handleError(res, error, "Failed to retrieve appointment demand.");
    }
});

// ------------------------------------------------------------
// Peak periods: appointments per weekday and hour (slot start)
// ------------------------------------------------------------
router.get("/peak-periods", async (req, res) => {
    try {
        const period = readPeriod(req.query);

        const { rows } = await pool.query(
            `SELECT (ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday',
                           'Friday', 'Saturday', 'Sunday']
                    )[EXTRACT(ISODOW FROM ${LOCAL_DAY})::int] AS day_of_week,
                    EXTRACT(HOUR FROM ${LOCAL_DAY})::int      AS hour,
                    COUNT(*)::int                             AS count
             FROM appointments a
             WHERE NOT ${IS_CANCELLED}
               AND ${LOCAL_DAY}::date BETWEEN $1::date AND $2::date
               AND ($3::text IS NULL
                    OR a.department_id IN (
                        SELECT id FROM departments
                        WHERE department_name = $3::text))
               AND ($4::text IS NULL OR a.doctor_id = $4::text)
             GROUP BY 1, 2
             ORDER BY 1, 2`,
            [
                period.dateFrom,
                period.dateTo,
                period.department,
                period.doctorId
            ]
        );

        res.json({ success: true, data: { heatmap: rows } });
    } catch (error) {
        handleError(res, error, "Failed to retrieve peak periods.");
    }
});

// ------------------------------------------------------------
// Doctor utilisation
//
// For every active doctor: the consultation slots of each day in the
// period, split into
//     booked   a non-cancelled appointment overlaps the slot
//     blocked  an OT / leave / other block overlaps it (and nothing booked)
//     free     everything else
// available = booked + free, utilisation = booked / available.
// ------------------------------------------------------------
router.get("/doctor-utilisation", async (req, res) => {
    try {
        const period = readPeriod(req.query);

        const doctors = (await pool.query(
            `SELECT d.doctor_id,
                    d.full_name         AS doctor_name,
                    dep.department_name AS department
             FROM doctors d
             JOIN departments dep ON dep.id = d.department_id
             WHERE d.is_active
               AND ($1::text IS NULL OR dep.department_name = $1::text)
             ORDER BY d.full_name`,
            [period.department]
        )).rows;

        if (!doctors.length) {
            return res.json({ success: true, data: { items: [] } });
        }

        const ids = doctors.map(d => d.doctor_id);
        const fromStart =
            `(($2::date)::timestamp AT TIME ZONE ${TZ})`;
        const toEnd =
            `(($3::date + 1)::timestamp AT TIME ZONE ${TZ})`;
        const range = [ids, period.dateFrom, period.dateTo];

        const [hoursResult, blockResult, apptResult] = await Promise.all([
            pool.query(
                `SELECT doctor_id, day_of_week, is_working, slot_minutes,
                        to_char(morning_start,   'HH24:MI') AS morning_start,
                        to_char(morning_end,     'HH24:MI') AS morning_end,
                        to_char(afternoon_start, 'HH24:MI') AS afternoon_start,
                        to_char(afternoon_end,   'HH24:MI') AS afternoon_end
                 FROM doctor_consultation_hours
                 WHERE doctor_id = ANY($1::text[])`,
                [ids]
            ),

            pool.query(
                `SELECT doctor_id,
                        (EXTRACT(EPOCH FROM starts_at) * 1000)::float8 AS s,
                        (EXTRACT(EPOCH FROM ends_at)   * 1000)::float8 AS e
                 FROM doctor_unavailability
                 WHERE doctor_id = ANY($1::text[])
                   AND starts_at < ${toEnd}
                   AND ends_at   > ${fromStart}`,
                range
            ),

            pool.query(
                `SELECT a.doctor_id,
                        (EXTRACT(EPOCH FROM a.scheduled_at) * 1000)::float8 AS t
                 FROM appointments a
                 WHERE a.doctor_id = ANY($1::text[])
                   AND NOT ${IS_CANCELLED}
                   AND a.scheduled_at >= ${fromStart}
                   AND a.scheduled_at <  ${toEnd}`,
                range
            )
        ]);

        const group = (rows, pick) => {
            const map = new Map();

            rows.forEach(row => {
                if (!map.has(row.doctor_id)) map.set(row.doctor_id, []);
                map.get(row.doctor_id).push(pick(row));
            });

            return map;
        };

        const hoursBy = group(hoursResult.rows, row => row);
        const blocksBy = group(blockResult.rows, row => row);
        const apptsBy = group(apptResult.rows, row => row.t);

        // The dates of the period with their weekday (0 = Monday).
        const first = Date.parse(period.dateFrom + "T00:00:00Z");
        const dates = [];

        for (let i = 0; i < period.days; i++) {
            const day = new Date(first + i * DAY_MS);

            dates.push({
                text: day.toISOString().slice(0, 10),
                weekday: (day.getUTCDay() + 6) % 7
            });
        }

        const items = [];

        doctors.forEach(doctor => {
            const saved = hoursBy.get(doctor.doctor_id) || [];
            const blocks = blocksBy.get(doctor.doctor_id) || [];
            const appts = apptsBy.get(doctor.doctor_id) || [];

            const slotMinutes = saved.length
                ? saved[0].slot_minutes
                : DEFAULT_SLOT_MINUTES;
            const slotMs = slotMinutes * 60000;

            let booked = 0;
            let free = 0;
            let blocked = 0;

            dates.forEach(day => {
                // Sessions of that weekday: saved hours, or the defaults
                // when the doctor has never saved any.
                let sessions = [];

                if (saved.length) {
                    const row = saved.find(
                        r => r.day_of_week === day.weekday + 1
                    );

                    if (row && row.is_working) {
                        if (row.morning_start && row.morning_end) {
                            sessions.push([row.morning_start, row.morning_end]);
                        }

                        if (row.afternoon_start && row.afternoon_end) {
                            sessions.push([row.afternoon_start, row.afternoon_end]);
                        }
                    }
                } else if (DEFAULT_DAYS[day.weekday]) {
                    sessions = [
                        DEFAULT_DAYS[day.weekday].morning,
                        DEFAULT_DAYS[day.weekday].afternoon
                    ].filter(Boolean);
                }

                const dayStart = Date.parse(day.text + "T00:00:00" + OFFSET);

                sessions.forEach(([start, end]) => {
                    for (
                        let t = toMinutes(start);
                        t + slotMinutes <= toMinutes(end);
                        t += slotMinutes
                    ) {
                        const slotStart = dayStart + t * 60000;
                        const slotEnd = slotStart + slotMs;

                        if (appts.some(a => a < slotEnd && a + slotMs > slotStart)) {
                            booked++;
                        } else if (blocks.some(b => b.s < slotEnd && b.e > slotStart)) {
                            blocked++;
                        } else {
                            free++;
                        }
                    }
                });
            });

            if (booked + free + blocked === 0) return;

            const available = booked + free;

            items.push({
                doctorId: doctor.doctor_id,
                doctorName: doctor.doctor_name,
                department: doctor.department,
                bookedSlots: booked,
                freeSlots: free,
                blockedSlots: blocked,
                availableSlots: available,
                utilisationPercent: available
                    ? Math.round(booked / available * 100)
                    : 0
            });
        });

        res.json({ success: true, data: { items } });
    } catch (error) {
        handleError(res, error, "Failed to retrieve doctor utilisation.");
    }
});


// ------------------------------------------------------------
// The cancellations route below is the group's original, unchanged
// (it still takes start_date / end_date / department_id).
// ------------------------------------------------------------

// GET /api/analytics/cancellations
// Analyse cancelled appointments
router.get('/cancellations', async (req, res) => {
    try {
        const { start_date, end_date, department_id } = req.query;

        let query = `
            SELECT
                COUNT(*) AS total_appointments,

                COUNT(*) FILTER (
                    WHERE a.status = 'CANCELLED'
                ) AS cancelled_appointments,

                COUNT(*) FILTER (
                    WHERE a.status <> 'CANCELLED'
                ) AS non_cancelled_appointments,

                ROUND(
                    COUNT(*) FILTER (
                        WHERE a.status = 'CANCELLED'
                    ) * 100.0 /
                    NULLIF(COUNT(*), 0),
                    2
                ) AS cancellation_percentage

            FROM appointments a
            WHERE 1 = 1
        `;

        const values = [];

        if (start_date) {
            values.push(start_date);
            query += ` AND a.scheduled_at >= $${values.length}::timestamptz`;
        }

        if (end_date) {
            values.push(end_date);
            query += ` AND a.scheduled_at < ($${values.length}::date + INTERVAL '1 day')`;
        }

        if (department_id) {
            values.push(department_id);
            query += ` AND a.department_id = $${values.length}`;
        }

        const summary = await pool.query(query, values);

        // Cancellation breakdown by department
        let departmentQuery = `
            SELECT
                dep.id AS department_id,
                dep.department_name,
                COUNT(a.id) AS cancelled_appointments

            FROM appointments a

            LEFT JOIN departments dep
                ON a.department_id = dep.id

            WHERE a.status = 'CANCELLED'
        `;

        const departmentValues = [];

        if (start_date) {
            departmentValues.push(start_date);
            departmentQuery += ` AND a.scheduled_at >= $${departmentValues.length}::timestamptz`;
        }

        if (end_date) {
            departmentValues.push(end_date);
            departmentQuery += ` AND a.scheduled_at < ($${departmentValues.length}::date + INTERVAL '1 day')`;
        }

        if (department_id) {
            departmentValues.push(department_id);
            departmentQuery += ` AND a.department_id = $${departmentValues.length}`;
        }

        departmentQuery += `
            GROUP BY dep.id, dep.department_name
            ORDER BY cancelled_appointments DESC
        `;

        const departmentResult = await pool.query(
            departmentQuery,
            departmentValues
        );

        res.json({
            message: 'Cancellation analytics retrieved successfully.',
            summary: summary.rows[0],
            departmentBreakdown: departmentResult.rows
        });

    } catch (err) {
        console.error('Cancellation analytics error:', err.message);

        res.status(500).json({
            error: 'Failed to retrieve cancellation analytics.'
        });
    }
});

module.exports = router;