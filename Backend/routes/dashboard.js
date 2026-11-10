/*
    routes/dashboard.js  ->  GET /api/dashboard/summary

    Returns what Dashboard.js (HospitalAnalytics.html) draws:

        todaysAppointments, upcomingNext7Days, cancellationsToday,
        doctorsOnDuty, doctorsTotal,
        todaysSchedule[], doctorAvailability[], needsAttention[],
        appointmentsByDepartment[], bookedVsCancelledLast7Days[]

    "Today" and "this week" are Asia/Kuala_Lumpur days. Appointments are
    counted on the day they are scheduled for. Statuses are translated by
    lib/status.js (CONFIRMED -> Booked and so on).

    Needs schedule_tables.sql (doctor_consultation_hours and
    doctor_unavailability) to have been run.
*/

const express = require("express");

const router = express.Router();

const db = require("../config/database");
const pool = db.pool || db;

const { ACTIVE_DB, uiStatusSql } = require("../lib/status");
const { TIME_ZONE } = require("../lib/slots");

const TZ = `'${TIME_ZONE}'`;
const UI_STATUS = uiStatusSql("a");

const IS_CANCELLED = "UPPER(a.status) IN ('CANCELLED', 'CANCELED')";

// Midnight of today (and of the Monday of this week) in clinic time.
const TODAY_START =
    `(date_trunc('day', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`;
const WEEK_START =
    `(date_trunc('week', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`;

// Appointment length of the doctor on row alias "a".
const SLOT_SQL = `(COALESCE(
        (SELECT h.slot_minutes
         FROM doctor_consultation_hours h
         WHERE h.doctor_id = a.doctor_id
         LIMIT 1), 30) * interval '1 minute')`;

const ACTIVE_LIST = ACTIVE_DB.map(s => `'${s}'`).join(", ");

// An upcoming appointment that overlaps an OT, leave or other block.
const CONFLICT_SQL = `(
    UPPER(a.status) IN (${ACTIVE_LIST})
    AND a.scheduled_at >= now()
    AND EXISTS (
        SELECT 1
        FROM doctor_unavailability u
        WHERE u.doctor_id = a.doctor_id
          AND a.scheduled_at <  u.ends_at
          AND a.scheduled_at + ${SLOT_SQL} > u.starts_at
    )
)`;

router.get("/summary", async (req, res) => {
    try {
        const [
            cards,
            doctorTotals,
            schedule,
            availability,
            clashes,
            byDepartment,
            trend
        ] = await Promise.all([
            // Card figures.
            pool.query(`
                SELECT
                    COUNT(*) FILTER (
                        WHERE a.scheduled_at >= ${TODAY_START}
                          AND a.scheduled_at <  ${TODAY_START} + interval '1 day'
                          AND NOT ${IS_CANCELLED}
                    )::int AS todays_appointments,
                    COUNT(*) FILTER (
                        WHERE a.scheduled_at >= ${TODAY_START}
                          AND a.scheduled_at <  ${TODAY_START} + interval '1 day'
                          AND ${IS_CANCELLED}
                    )::int AS cancellations_today,
                    COUNT(*) FILTER (
                        WHERE a.scheduled_at >= now()
                          AND a.scheduled_at <  now() + interval '7 days'
                          AND UPPER(a.status) IN (${ACTIVE_LIST})
                    )::int AS upcoming_next_7_days
                FROM appointments a
            `),

            pool.query(`
                SELECT COUNT(*)::int AS total
                FROM doctors
                WHERE is_active
            `),

            // Today's schedule (cancelled ones are counted separately).
            pool.query(`
                SELECT COALESCE(a.external_appointment_id, a.id::text) AS id,
                       p.full_name           AS patient_name,
                       a.doctor_id           AS doctor_id,
                       d.full_name           AS doctor_name,
                       dep.department_name   AS department,
                       to_char(a.scheduled_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD')
                                             AS date,
                       to_char(a.scheduled_at AT TIME ZONE ${TZ}, 'HH24:MI')
                                             AS time,
                       ${UI_STATUS}          AS status
                FROM appointments a
                LEFT JOIN patients    p   ON p.id = a.patient_id
                LEFT JOIN doctors     d   ON d.doctor_id = a.doctor_id
                LEFT JOIN departments dep ON dep.id = a.department_id
                WHERE a.scheduled_at >= ${TODAY_START}
                  AND a.scheduled_at <  ${TODAY_START} + interval '1 day'
                  AND NOT ${IS_CANCELLED}
                ORDER BY a.scheduled_at, a.id
                LIMIT 50
            `),

            // Active doctors who work today: On duty, In OT (an OT block is
            // running now) or On leave (a Leave block touches today).
            // A doctor with no saved hours follows the defaults in ams.js
            // (Monday to Saturday).
            pool.query(`
                SELECT d.doctor_id,
                       d.full_name           AS doctor_name,
                       dep.department_name   AS department,
                       CASE
                           WHEN lv.ends_at IS NOT NULL THEN 'On leave'
                           WHEN ot.ends_at IS NOT NULL THEN 'In OT'
                           ELSE 'On duty'
                       END                   AS state,
                       CASE
                           WHEN lv.ends_at IS NOT NULL THEN
                               'until ' || to_char(lv.ends_at AT TIME ZONE ${TZ},
                                                   'DD Mon')
                           WHEN ot.ends_at IS NOT NULL THEN
                               'OT until ' || to_char(ot.ends_at AT TIME ZONE ${TZ},
                                                      'HH24:MI')
                           ELSE NULL
                       END                   AS note
                FROM doctors d
                JOIN departments dep ON dep.id = d.department_id
                LEFT JOIN LATERAL (
                    SELECT u.ends_at
                    FROM doctor_unavailability u
                    WHERE u.doctor_id = d.doctor_id
                      AND u.block_type = 'Leave'
                      AND u.starts_at < ${TODAY_START} + interval '1 day'
                      AND u.ends_at   > ${TODAY_START}
                    ORDER BY u.ends_at DESC
                    LIMIT 1
                ) lv ON true
                LEFT JOIN LATERAL (
                    SELECT u.ends_at
                    FROM doctor_unavailability u
                    WHERE u.doctor_id = d.doctor_id
                      AND u.block_type = 'OT'
                      AND now() >= u.starts_at
                      AND now() <  u.ends_at
                    LIMIT 1
                ) ot ON true
                WHERE d.is_active
                  AND CASE
                        WHEN EXISTS (SELECT 1 FROM doctor_consultation_hours h
                                     WHERE h.doctor_id = d.doctor_id)
                        THEN EXISTS (SELECT 1 FROM doctor_consultation_hours h
                                     WHERE h.doctor_id = d.doctor_id
                                       AND h.is_working
                                       AND h.day_of_week = EXTRACT(
                                           ISODOW FROM now() AT TIME ZONE ${TZ}
                                       )::int)
                        ELSE EXTRACT(ISODOW FROM now() AT TIME ZONE ${TZ}) <= 6
                      END
                ORDER BY d.full_name
            `),

            // Upcoming appointments that clash with a block, per doctor.
            pool.query(`
                SELECT COALESCE(d.full_name, a.doctor_id) AS doctor_name,
                       COUNT(*)::int                      AS clashes
                FROM appointments a
                LEFT JOIN doctors d ON d.doctor_id = a.doctor_id
                WHERE ${CONFLICT_SQL}
                GROUP BY 1
                ORDER BY clashes DESC, 1
                LIMIT 5
            `),

            // This week (Monday to Sunday), cancelled ones left out.
            pool.query(`
                SELECT dep.department_name AS name,
                       COUNT(*)::int       AS count
                FROM appointments a
                JOIN departments dep ON dep.id = a.department_id
                WHERE a.scheduled_at >= ${WEEK_START}
                  AND a.scheduled_at <  ${WEEK_START} + interval '7 days'
                  AND NOT ${IS_CANCELLED}
                GROUP BY dep.department_name
                ORDER BY count DESC, dep.department_name
            `),

            // Last 7 days including today, one row per day.
            pool.query(`
                SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
                       COUNT(a.id) FILTER (WHERE NOT ${IS_CANCELLED})::int
                                                    AS booked,
                       COUNT(a.id) FILTER (WHERE ${IS_CANCELLED})::int
                                                    AS cancelled
                FROM generate_series(
                         (now() AT TIME ZONE ${TZ})::date - 6,
                         (now() AT TIME ZONE ${TZ})::date,
                         interval '1 day'
                     ) AS g(day)
                LEFT JOIN appointments a
                       ON (a.scheduled_at AT TIME ZONE ${TZ})::date = g.day::date
                GROUP BY g.day
                ORDER BY g.day
            `)
        ]);

        const figures = cards.rows[0];

        const needsAttention = clashes.rows.map(row => ({
            kind: "OtClash",
            message:
                row.doctor_name + ": " + row.clashes +
                (row.clashes === 1 ? " appointment clashes" : " appointments clash") +
                " with OT, leave or another block."
        }));

        res.json({
            success: true,
            data: {
                todaysAppointments: figures.todays_appointments,
                upcomingNext7Days: figures.upcoming_next_7_days,
                cancellationsToday: figures.cancellations_today,
                doctorsOnDuty: availability.rows.filter(
                    row => row.state !== "On leave"
                ).length,
                doctorsTotal: doctorTotals.rows[0].total,

                todaysSchedule: schedule.rows,
                doctorAvailability: availability.rows,
                needsAttention,
                appointmentsByDepartment: byDepartment.rows,
                bookedVsCancelledLast7Days: trend.rows
            }
        });
    } catch (error) {
        console.error("Dashboard summary error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to retrieve dashboard statistics."
        });
    }
});

module.exports = router;