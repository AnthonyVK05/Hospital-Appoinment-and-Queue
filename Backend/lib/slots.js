/*
    lib/slots.js   (put it in backend/lib/, NOT in routes/ -- every file in
    routes/ is mounted as an API path)

    Works out the time slots of one doctor on one date. Used by
    GET /api/appointments/availability and again by create / reschedule so
    the server never books a slot the form should not have offered.

    q is the pg Pool or a pg client (inside a transaction).
*/

const TIME_ZONE = "Asia/Kuala_Lumpur";
const DEFAULT_SLOT_MINUTES = 30;

// Same defaults as AMS.getDefaultConsultationHours in ams.js.
// Index 0 = Monday ... 6 = Sunday.
const DEFAULT_DAYS = [
    { morning: ["09:00", "12:00"], afternoon: ["14:00", "17:00"] },
    { morning: ["09:00", "12:00"], afternoon: ["14:00", "17:00"] },
    { morning: ["09:00", "12:00"], afternoon: ["14:00", "17:00"] },
    { morning: ["09:00", "12:00"], afternoon: ["14:00", "17:00"] },
    { morning: ["09:00", "12:00"], afternoon: ["14:00", "17:00"] },
    { morning: ["09:00", "12:00"], afternoon: null },
    null
];

const toMinutes = time =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const toTime = minutes =>
    String(Math.floor(minutes / 60)).padStart(2, "0") + ":" +
    String(minutes % 60).padStart(2, "0");

function blockState(type) {
    if (type === "OT") return "ot";
    if (type === "Leave") return "leave";
    return "other";
}

// excludeId: the appointment being edited (its own slot stays free).
// Returns { slotMinutes, slots: [{ time: "09:00", state }] } where state is
// free | booked | ot | leave | other.
async function getSlots(q, doctorId, date, excludeId) {
    // Start of the date in clinic time.
    const dayStart =
        `(($2::date)::timestamp AT TIME ZONE '${TIME_ZONE}')`;

    const hours = await q.query(
        `SELECT is_working,
                slot_minutes,
                to_char(morning_start,   'HH24:MI') AS morning_start,
                to_char(morning_end,     'HH24:MI') AS morning_end,
                to_char(afternoon_start, 'HH24:MI') AS afternoon_start,
                to_char(afternoon_end,   'HH24:MI') AS afternoon_end
         FROM doctor_consultation_hours
         WHERE doctor_id = $1
           AND day_of_week = EXTRACT(ISODOW FROM $2::date)::int`,
        [doctorId, date]
    );

    let slotMinutes = DEFAULT_SLOT_MINUTES;
    let sessions = [];

    if (hours.rowCount) {
        const row = hours.rows[0];
        slotMinutes = row.slot_minutes;

        if (row.is_working) {
            if (row.morning_start && row.morning_end) {
                sessions.push([row.morning_start, row.morning_end]);
            }

            if (row.afternoon_start && row.afternoon_end) {
                sessions.push([row.afternoon_start, row.afternoon_end]);
            }
        }
    } else {
        // No row for this weekday. Use the defaults only when the doctor
        // has no saved hours at all (never configured).
        const savedAny = await q.query(
            `SELECT slot_minutes FROM doctor_consultation_hours
             WHERE doctor_id = $1 LIMIT 1`,
            [doctorId]
        );

        if (savedAny.rowCount) {
            slotMinutes = savedAny.rows[0].slot_minutes;
        } else {
            const weekday =
                (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
            const day = DEFAULT_DAYS[weekday];

            if (day) {
                sessions = [day.morning, day.afternoon].filter(Boolean);
            }
        }
    }

    // Blocks as minutes since local midnight of the date.
    const blockResult = await q.query(
        `SELECT u.block_type,
                (EXTRACT(EPOCH FROM
                    GREATEST(u.starts_at, ${dayStart}) - ${dayStart}
                ) / 60)::float8 AS start_min,
                (EXTRACT(EPOCH FROM
                    LEAST(u.ends_at, ${dayStart} + interval '1 day')
                    - ${dayStart}
                ) / 60)::float8 AS end_min
         FROM doctor_unavailability u
         WHERE u.doctor_id = $1
           AND u.starts_at < ${dayStart} + interval '1 day'
           AND u.ends_at   > ${dayStart}`,
        [doctorId, date]
    );

    // Open appointments that day, as minutes since local midnight. A
    // cancelled appointment frees its slot.
    const bookedResult = await q.query(
        `SELECT (EXTRACT(EPOCH FROM a.scheduled_at - ${dayStart})
                 / 60)::float8 AS start_min
         FROM appointments a
         WHERE a.doctor_id = $1
           AND a.scheduled_at >= ${dayStart}
           AND a.scheduled_at <  ${dayStart} + interval '1 day'
           AND LOWER(a.status) NOT IN ('cancelled', 'canceled')
           AND ($3::text = ''
                OR (a.external_appointment_id IS DISTINCT FROM $3::text
                    AND a.id::text <> $3::text))`,
        [doctorId, date, excludeId || ""]
    );

    const nowResult = await q.query(
        `SELECT to_char(now() AT TIME ZONE '${TIME_ZONE}',
                        'YYYY-MM-DD') AS today,
                (EXTRACT(HOUR   FROM now() AT TIME ZONE '${TIME_ZONE}') * 60
               + EXTRACT(MINUTE FROM now() AT TIME ZONE '${TIME_ZONE}'))::int
                    AS minutes`
    );

    const today = nowResult.rows[0].today;
    const nowMinutes = nowResult.rows[0].minutes;

    const blocks = blockResult.rows.map(row => ({
        state: blockState(row.block_type),
        start: row.start_min,
        end: row.end_min
    }));

    const booked = bookedResult.rows.map(row => row.start_min);
    const slots = [];

    if (date >= today) {
        sessions.forEach(([start, end]) => {
            for (
                let t = toMinutes(start);
                t + slotMinutes <= toMinutes(end);
                t += slotMinutes
            ) {
                // Leave out slots that have already started today.
                if (date === today && t <= nowMinutes) continue;

                const slotEnd = t + slotMinutes;

                // An appointment overlaps the slot when it starts before
                // the slot ends and ends after it starts.
                const isBooked = booked.some(
                    b => b < slotEnd && b + slotMinutes > t
                );

                const block = blocks.find(
                    b => b.start < slotEnd && b.end > t
                );

                slots.push({
                    time: toTime(t),
                    state: isBooked
                        ? "booked"
                        : block ? block.state : "free"
                });
            }
        });
    }

    slots.sort((a, b) => a.time.localeCompare(b.time));

    return { slotMinutes, slots };
}

module.exports = {
    getSlots,
    TIME_ZONE,
    DEFAULT_DAYS,
    DEFAULT_SLOT_MINUTES,
    toMinutes
};