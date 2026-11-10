/*
    lib/status.js   (backend/lib/, next to slots.js)

    The shared appointments table stores statuses in capitals
    (CONFIRMED, CHECKED_IN, CANCELLED ...). The AMS pages use Booked,
    Rescheduled, Completed, Cancelled and No-show. This file is the one
    place that translates between the two. Check the values your table
    really uses with:

        SELECT status, COUNT(*) FROM appointments GROUP BY status;
        SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'appointments'::regclass AND contype = 'c';

    and change DB_STATUS below if a name differs (RESCHEDULED, COMPLETED
    and NO_SHOW are guesses; CONFIRMED, CHECKED_IN and CANCELLED come from
    the existing rows).
*/

// What AMS writes to appointments.status.
const DB_STATUS = {
    "Booked":      "CONFIRMED",
    "Rescheduled": "RESCHEDULED",
    "Completed":   "COMPLETED",
    "Cancelled":   "CANCELLED",
    "No-show":     "NO_SHOW"
};

// Appointments AMS may edit, cancel or mark Completed / No-show
// (shown as Booked or Rescheduled).
const OPEN_DB = ["CONFIRMED", "BOOKED", "SCHEDULED", "RESCHEDULED"];

// Everything that still counts as an upcoming appointment of a doctor
// (open ones plus a patient who has already checked in).
const ACTIVE_DB = [...OPEN_DB, "CHECKED_IN"];

// SQL that turns the stored status into the AMS name.
// Anything else is shown readable, e.g. CHECKED_IN -> "Checked In".
function uiStatusSql(alias) {
    const s = `UPPER(${alias}.status)`;

    return `(CASE
        WHEN ${s} IN ('CONFIRMED', 'BOOKED', 'SCHEDULED') THEN 'Booked'
        WHEN ${s} = 'RESCHEDULED'                         THEN 'Rescheduled'
        WHEN ${s} = 'COMPLETED'                           THEN 'Completed'
        WHEN ${s} IN ('CANCELLED', 'CANCELED')            THEN 'Cancelled'
        WHEN ${s} IN ('NO_SHOW', 'NO-SHOW')               THEN 'No-show'
        ELSE initcap(replace(${alias}.status, '_', ' '))
    END)`;
}

module.exports = { DB_STATUS, OPEN_DB, ACTIVE_DB, uiStatusSql };