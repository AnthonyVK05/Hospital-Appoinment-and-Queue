/*
 * ams.js - Appointment Management System (frontend module)
 *
 * Modelled on qms.js:
 *   - one global module object, AMS, built with an IIFE
 *   - no localStorage for records: data lives in PostgreSQL and is
 *     loaded through the Express API (fetch), then cached in memory
 *   - helper functions for status, time, slots and validation
 *
 * Covers: appointments, doctors, departments, consultation hours,
 * OT/leave blocks, dashboard and analytics, and staff login.
 * Notifications are NOT part of this file.
 *
 * Usage (in each page, before the page script):
 *   <script>window.AMS_API_BASE = "http://localhost:3000/api";</script>   (optional)
 *   <script src="ams.js"></script>
 *   <script src="ams-api.js"></script>   (network layer, like qms-api.js)
 *   <script src="ams-ui.js"></script>
 *
 * Conventions:
 *   - Read functions (load..., get... from the server) return data and
 *     throw an AmsError when the request fails.
 *   - Write functions (create, update, cancel, ...) never throw. They
 *     return { success, message, ... } like the QMS call/complete functions.
 *   - Dates are "YYYY-MM-DD", times are "HH:MM" (24-hour), date-times
 *     are local "YYYY-MM-DDTHH:MM".
 */

const AMS = (() => {
    "use strict";

    // ============================================
    // CONFIGURATION
    // ============================================

    // "/api" when Express serves the pages (same as qms-api.js).
    // Pages opened from VS Code Live Server (port 5500) or from a file
    // call the backend on port 3000 directly.
    function defaultApiBase() {
        const opened =
            window.location.protocol === "file:" ||
            ["5500", "5501"].includes(window.location.port);

        return opened
            ? "http://localhost:3000/api"
            : "/api";
    }

    const API_BASE = (
        window.AMS_API_BASE || defaultApiBase()
    ).replace(/\/+$/, "");

    // Only the staff session is kept in the browser.
    // Appointments, doctors and schedules are never stored here.
    const SESSION_KEYS = {
        staffID: "staffID",
        token: "amsToken"
    };

    const TIME_ZONE = "Asia/Kuala_Lumpur";

    const APPOINTMENT_STATUSES = [
        "Booked",
        "Rescheduled",
        "Completed",
        "Cancelled",
        "No-show"
    ];

    // Closed appointments cannot be edited or cancelled. "Checked In"
    // (set by the queue module when the patient arrives) is locked too.
    const CLOSED_STATUSES = [
        "Completed",
        "Cancelled",
        "No-show",
        "Checked In"
    ];

    const DOCTOR_STATUSES = [
        "Active",
        "On leave",
        "Inactive"
    ];

    const BLOCK_TYPES = [
        "OT",
        "Leave",
        "Conference",
        "Other"
    ];

    const CANCEL_REASONS = [
        "Patient request",
        "Doctor unavailable",
        "Doctor in OT",
        "Duplicate booking",
        "Other"
    ];

    const DAYS = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday"
    ];

    const SLOT_LENGTHS = [15, 30, 45, 60];
    const DEFAULT_SLOT_MINUTES = 30;

    // Doctor utilisation load thresholds (percent)
    const UTILISATION_LOW = 50;
    const UTILISATION_HIGH = 85;

    // CSS classes from Dashboard.css
    const STATUS_BADGES = {
        "Booked": "badge-booked",
        "Rescheduled": "badge-rescheduled",
        "Completed": "badge-completed",
        "Cancelled": "badge-cancelled",
        "No-show": "badge-noshow"
    };

    const DOCTOR_BADGES = {
        "Active": "badge-duty",
        "On leave": "badge-leave",
        "Inactive": "badge-inactive"
    };

    const BLOCK_BADGES = {
        "OT": "badge-ot",
        "Leave": "badge-leave",
        "Conference": "badge-conference",
        "Other": "badge-inactive"
    };

    const AVAILABILITY_BADGES = {
        "On duty": "badge-duty",
        "In OT": "badge-ot",
        "On leave": "badge-leave"
    };

    // ============================================
    // ERRORS
    // ============================================

    class AmsError extends Error {
        constructor(message, status, code, details, data) {
            super(message);

            this.name = "AmsError";
            this.status = status || 0;
            this.code = code || null;
            this.details = details || [];
            this.data = data || null;
        }
    }

    function getErrorMessage(error) {
        if (!error) return "Something went wrong.";

        if (
            Array.isArray(error.details) &&
            error.details.length
        ) {
            return error.details
                .map(item => item.message)
                .filter(Boolean)
                .join(" ") || error.message;
        }

        return error.message || "Something went wrong.";
    }

    // ============================================
    // IN-MEMORY CACHE
    // ============================================

    // Filled by the load functions below.
    // Replaced whenever the server data is reloaded.
    const cache = {
        departments: [],
        doctors: [],
        appointments: [],
        appointmentsPage: null,
        doctorsPage: null
    };

    // ============================================
    // STAFF SESSION
    // ============================================

    function getToken() {
        return sessionStorage.getItem(SESSION_KEYS.token);
    }

    function getSession() {
        return {
            staffID: sessionStorage.getItem(
                SESSION_KEYS.staffID
            ),

            token: getToken()
        };
    }

    function isLoggedIn() {
        return Boolean(getToken());
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEYS.staffID);
        sessionStorage.removeItem(SESSION_KEYS.token);
    }

    // ============================================
    // API CLIENT
    // ============================================

    function buildQuery(params) {
        const search = new URLSearchParams();

        Object.keys(params || {}).forEach(key => {
            const value = params[key];

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                return;
            }

            search.append(key, String(value));
        });

        const text = search.toString();

        return text ? "?" + text : "";
    }

    // The network layer lives in ams-api.js (like qms-api.js for QMS).
    // It adds the token, reads the { success } envelope, converts
    // snake_case keys and throws AmsError when a request fails.
    function request(method, path, body) {
        if (!window.AMS_API) {
            throw new AmsError(
                "ams-api.js is not loaded. Add " +
                "<script src=\"ams-api.js\"></script> after ams.js.",
                0,
                "API_NOT_LOADED"
            );
        }

        return window.AMS_API.request(method, path, body);
    }

    // Wraps a write so it returns { success, message, ... }
    // instead of throwing.
    async function attempt(action, key, successMessage) {
        try {
            const data = await action();

            return {
                success: true,
                [key]: data,
                message: successMessage
            };
        } catch (error) {
            return {
                success: false,
                [key]: null,
                message: getErrorMessage(error),
                code: error.code || null,
                status: error.status || 0,
                details: error.details || [],
                upcomingAppointments:
                    error.data &&
                    error.data.upcomingAppointments !== undefined
                        ? error.data.upcomingAppointments
                        : null
            };
        }
    }

    // Accepts { items, page, ... } or a plain array.
    function toPage(data) {
        if (Array.isArray(data)) {
            return {
                items: data,
                page: 1,
                pageSize: data.length,
                totalItems: data.length
            };
        }

        return {
            items: (data && data.items) || [],
            page: (data && data.page) || 1,
            pageSize: (data && data.pageSize) || 0,
            totalItems: (data && data.totalItems) || 0
        };
    }

    function replaceInCache(list, item) {
        if (!item || !item.id) return;

        const index = list.findIndex(
            entry => entry.id === item.id
        );

        if (index === -1) {
            list.unshift(item);
        } else {
            list[index] = item;
        }
    }

    // ============================================
    // AUTH
    // ============================================

    async function login(adminID, password) {
        return attempt(
            async () => {
                const data = await request(
                    "POST",
                    "/auth/login",
                    {
                        adminID: adminID,
                        password: password
                    }
                );

                if (!data || !data.session || !data.session.staff) {
                    throw new AmsError(
                        "Invalid login response from server.",
                        0,
                        "INVALID_RESPONSE"
                    );
                }

                sessionStorage.setItem(
                    SESSION_KEYS.staffID,
                    data.session.staff.staffId ||
                    data.session.staff.staff_id ||
                    adminID
                );

                // Temporary session marker.
                sessionStorage.setItem(
                    SESSION_KEYS.token,
                    "admin-session"
                );

                return data;
            },
            "session",
            "Logged in."
        );
    }
    function logout() {
        clearSession();
    }

    // ============================================
    // DEPARTMENTS
    // ============================================

    // The departments table is shared by the whole group,
    // so it is read-only here.
    async function loadDepartments() {
        const data = await request("GET", "/departments");

        cache.departments = Array.isArray(data)
            ? data
            : (data && data.items) || [];

        return cache.departments.slice();
    }

    function getDepartments() {
        return cache.departments.slice();
    }

    function normalizeDepartment(value) {
        if (!value) return null;

        let cleaned;

        try {
            cleaned = decodeURIComponent(String(value))
                .trim()
                .toLowerCase();
        } catch (error) {
            cleaned = String(value)
                .trim()
                .toLowerCase();
        }

        const match = cache.departments.find(
            department =>
                String(department.name).toLowerCase() ===
                cleaned
        );

        return match ? match.name : null;
    }

    function getDepartmentByName(name) {
        const normalized = normalizeDepartment(name);

        return cache.departments.find(
            department => department.name === normalized
        ) || null;
    }

    function getDepartmentFromUrl() {
        const params = new URLSearchParams(
            window.location.search
        );

        return normalizeDepartment(
            params.get("department")
        );
    }

    // ============================================
    // DOCTORS
    // ============================================

    // filters: { search, department, status, page, pageSize }
    async function loadDoctors(filters) {
        const data = await request(
            "GET",
            "/doctors" + buildQuery(filters)
        );

        const page = toPage(data);

        cache.doctors = page.items;
        cache.doctorsPage = page;

        return page;
    }

    function getDoctors() {
        return cache.doctors.slice();
    }

    function getDoctorById(doctorId) {
        if (!doctorId) return null;

        return cache.doctors.find(
            doctor => doctor.id === doctorId
        ) || null;
    }

    async function fetchDoctor(doctorId) {
        const doctor = await request(
            "GET",
            "/doctors/" + encodeURIComponent(doctorId)
        );

        replaceInCache(cache.doctors, doctor);

        return doctor;
    }

    // Only Active doctors can take new bookings.
    function getBookableDoctors(department) {
        const normalized = department
            ? normalizeDepartment(department) || department
            : null;

        return cache.doctors.filter(
            doctor =>
                doctor.status === "Active" &&
                (!normalized ||
                    doctor.department === normalized)
        );
    }

    function createDoctor(input) {
        return attempt(
            async () => {
                const doctor = await request(
                    "POST",
                    "/doctors",
                    input
                );

                replaceInCache(cache.doctors, doctor);

                return doctor;
            },
            "doctor",
            "Doctor created."
        );
    }

    function updateDoctor(doctorId, input) {
        return attempt(
            async () => {
                const doctor = await request(
                    "PUT",
                    "/doctors/" + encodeURIComponent(doctorId),
                    input
                );

                replaceInCache(cache.doctors, doctor);

                return doctor;
            },
            "doctor",
            "Doctor updated."
        );
    }

    // Doctors are deactivated, not deleted.
    // The server returns a conflict while the doctor still has
    // upcoming appointments (see result.upcomingAppointments).
    function setDoctorStatus(doctorId, status) {
        return attempt(
            async () => {
                const doctor = await request(
                    "PATCH",
                    "/doctors/" +
                        encodeURIComponent(doctorId) +
                        "/status",
                    { status }
                );

                replaceInCache(cache.doctors, doctor);

                return doctor;
            },
            "doctor",
            "Doctor status set to " + status + "."
        );
    }

    function uploadDoctorPhoto(doctorId, file) {
        return attempt(
            () => {
                const form = new FormData();
                form.append("photo", file);

                return request(
                    "PUT",
                    "/doctors/" +
                        encodeURIComponent(doctorId) +
                        "/photo",
                    form
                );
            },
            "photo",
            "Photo saved."
        );
    }

    function getDoctorInitials(name) {
        const parts = String(name || "")
            .replace(/^Dr\.?\s*/i, "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);

        if (!parts.length) return "?";

        return (
            parts[0][0] +
            (parts[1] ? parts[1][0] : "")
        ).toUpperCase();
    }

    function validateDoctorInput(input) {
        const errors = {};
        const data = input || {};

        if (!String(data.name || "").trim()) {
            errors.name = "Enter the doctor's name.";
        }

        if (!data.department) {
            errors.department = "Select a department.";
        }

        if (!String(data.specialty || "").trim()) {
            errors.specialty = "Enter the specialty.";
        }

        if (!String(data.phone || "").trim()) {
            errors.phone = "Enter a phone number.";
        }

        if (!isValidEmail(data.email)) {
            errors.email = "Enter a valid email address.";
        }

        return {
            valid: Object.keys(errors).length === 0,
            errors
        };
    }

    // ============================================
    // TIME HELPERS
    // ============================================

    function pad(number) {
        return String(number).padStart(2, "0");
    }

    function toISODate(date) {
        return (
            date.getFullYear() + "-" +
            pad(date.getMonth() + 1) + "-" +
            pad(date.getDate())
        );
    }

    function todayISO() {
        return toISODate(new Date());
    }

    function timeToMinutes(value) {
        const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(
            String(value || "")
        );

        if (!match) return NaN;

        return Number(match[1]) * 60 + Number(match[2]);
    }

    function minutesToTime(minutes) {
        return (
            pad(Math.floor(minutes / 60)) + ":" +
            pad(minutes % 60)
        );
    }

    // "2026-10-20" + "09:30" as a local Date
    function combineDateTime(date, time) {
        return new Date(date + "T" + String(time).slice(0, 5));
    }

    function isValidEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            String(value || "").trim()
        );
    }

    // ============================================
    // CONSULTATION HOURS
    // ============================================

    /*
     * Shape (same as the API):
     * {
     *   slotMinutes: 30,
     *   days: [
     *     { day: "Monday", working: true,
     *       morning:   { start: "09:00", end: "12:00" },
     *       afternoon: { start: "14:00", end: "17:00" } },
     *     ...
     *   ]
     * }
     * A session set to null means no session.
     */

    function getDefaultConsultationHours(
        slotMinutes = DEFAULT_SLOT_MINUTES
    ) {
        const weekday = {
            morning: { start: "09:00", end: "12:00" },
            afternoon: { start: "14:00", end: "17:00" }
        };

        return {
            slotMinutes,
            days: DAYS.map(day => {
                if (day === "Sunday") {
                    return {
                        day,
                        working: false,
                        morning: null,
                        afternoon: null
                    };
                }

                if (day === "Saturday") {
                    return {
                        day,
                        working: true,
                        morning: { ...weekday.morning },
                        afternoon: null
                    };
                }

                return {
                    day,
                    working: true,
                    morning: { ...weekday.morning },
                    afternoon: { ...weekday.afternoon }
                };
            })
        };
    }

    async function loadConsultationHours(doctorId) {
        return request(
            "GET",
            "/doctors/" +
                encodeURIComponent(doctorId) +
                "/consultation-hours"
        );
    }

    // Returns { success, hours, affectedAppointments, message }
    function saveConsultationHours(doctorId, hours) {
        return attempt(
            () => request(
                "PUT",
                "/doctors/" +
                    encodeURIComponent(doctorId) +
                    "/consultation-hours",
                hours
            ),
            "result",
            "Consultation hours saved."
        ).then(result => ({
            success: result.success,
            message: result.message,
            code: result.code,
            details: result.details,
            hours: result.result ? result.result.hours : null,
            affectedAppointments: result.result
                ? result.result.affectedAppointments || []
                : []
        }));
    }

    function countSessionSlots(session, slotMinutes) {
        if (!session || !session.start || !session.end) {
            return 0;
        }

        const difference =
            timeToMinutes(session.end) -
            timeToMinutes(session.start);

        return difference > 0
            ? Math.floor(difference / slotMinutes)
            : 0;
    }

    function countDaySlots(daySchedule, slotMinutes) {
        if (!daySchedule || !daySchedule.working) {
            return 0;
        }

        return (
            countSessionSlots(daySchedule.morning, slotMinutes) +
            countSessionSlots(daySchedule.afternoon, slotMinutes)
        );
    }

    // Returns { valid, errors: [{ day, session, message }] }
    function validateConsultationHours(hours) {
        const errors = [];

        if (
            !hours ||
            !SLOT_LENGTHS.includes(Number(hours.slotMinutes))
        ) {
            errors.push({
                day: null,
                session: null,
                message: "Choose a valid appointment length."
            });
        }

        ((hours && hours.days) || []).forEach(item => {
            if (!item.working) return;

            const morning = item.morning;
            const afternoon = item.afternoon;
            const hasMorning = Boolean(
                morning && (morning.start || morning.end)
            );
            const hasAfternoon = Boolean(
                afternoon && (afternoon.start || afternoon.end)
            );

            function checkSession(session, label) {
                if (!session.start || !session.end) {
                    errors.push({
                        day: item.day,
                        session: label,
                        message:
                            "Enter both start and end, " +
                            "or clear both."
                    });

                    return false;
                }

                if (
                    timeToMinutes(session.end) <=
                    timeToMinutes(session.start)
                ) {
                    errors.push({
                        day: item.day,
                        session: label,
                        message: "End must be after start."
                    });

                    return false;
                }

                return true;
            }

            if (!hasMorning && !hasAfternoon) {
                errors.push({
                    day: item.day,
                    session: "morning",
                    message:
                        "Add at least one session, " +
                        "or mark the day as not working."
                });

                return;
            }

            const morningOk = hasMorning
                ? checkSession(morning, "morning")
                : true;

            const afternoonOk = hasAfternoon
                ? checkSession(afternoon, "afternoon")
                : true;

            if (
                morningOk && afternoonOk &&
                hasMorning && hasAfternoon &&
                timeToMinutes(afternoon.start) <
                    timeToMinutes(morning.end)
            ) {
                errors.push({
                    day: item.day,
                    session: "afternoon",
                    message:
                        "Afternoon must start after " +
                        "the morning ends."
                });
            }
        });

        return {
            valid: errors.length === 0,
            errors
        };
    }

    // ============================================
    // OT, LEAVE AND OTHER BLOCKS
    // ============================================

    function loadUnavailability(doctorId, range) {
        return request(
            "GET",
            "/doctors/" +
                encodeURIComponent(doctorId) +
                "/unavailability" +
                buildQuery(range)
        );
    }

    // input: { type, from, to, note, ... }
    // Returns { success, block, affectedAppointments, message }
    function addUnavailability(doctorId, input) {
        return attempt(
            () => request(
                "POST",
                "/doctors/" +
                    encodeURIComponent(doctorId) +
                    "/unavailability",
                input
            ),
            "result",
            "Block added."
        ).then(result => ({
            success: result.success,
            message: result.message,
            code: result.code,
            details: result.details,
            block: result.result ? result.result.block : null,
            affectedAppointments: result.result
                ? result.result.affectedAppointments || []
                : []
        }));
    }

    function removeUnavailability(doctorId, blockId) {
        return attempt(
            () => request(
                "DELETE",
                "/doctors/" +
                    encodeURIComponent(doctorId) +
                    "/unavailability/" +
                    encodeURIComponent(blockId)
            ),
            "removed",
            "Block removed."
        );
    }

    function validateUnavailabilityInput(input) {
        const errors = {};
        const data = input || {};

        if (!BLOCK_TYPES.includes(data.type)) {
            errors.type = "Choose a type.";
        }

        if (!data.from || !data.to) {
            errors.range = "Enter the from and to date and time.";
        } else if (
            new Date(data.to) <= new Date(data.from)
        ) {
            errors.range = "The end must be after the start.";
        }

        return {
            valid: Object.keys(errors).length === 0,
            errors
        };
    }

    // True when two blocks share any time. Both use { from, to }.
    function blocksOverlap(a, b) {
        return (
            new Date(a.from) < new Date(b.to) &&
            new Date(a.to) > new Date(b.from)
        );
    }

    // Client-side preview of which appointments a block would
    // clash with. The server is still the source of truth.
    function appointmentsOverlappingBlock(
        appointments,
        block,
        slotMinutes = DEFAULT_SLOT_MINUTES
    ) {
        const blockStart = new Date(block.from).getTime();
        const blockEnd = new Date(block.to).getTime();

        return (appointments || []).filter(appointment => {
            if (CLOSED_STATUSES.includes(appointment.status)) {
                return false;
            }

            const start = getAppointmentStart(
                appointment
            ).getTime();

            const end = start + slotMinutes * 60000;

            return start < blockEnd && end > blockStart;
        });
    }

    // ============================================
    // APPOINTMENTS
    // ============================================

    /*
     * filters: {
     *   search, status, department, doctorId,
     *   dateFrom, dateTo, conflict, page, pageSize
     * }
     */
    async function loadAppointments(filters) {
        const data = await request(
            "GET",
            "/appointments" + buildQuery(filters)
        );

        const page = toPage(data);

        cache.appointments = page.items;
        cache.appointmentsPage = page;

        return page;
    }

    function getAppointments() {
        return cache.appointments.slice();
    }

    function getAppointmentById(appointmentId) {
        if (!appointmentId) return null;

        return cache.appointments.find(
            appointment => appointment.id === appointmentId
        ) || null;
    }

    async function fetchAppointment(appointmentId) {
        const appointment = await request(
            "GET",
            "/appointments/" +
                encodeURIComponent(appointmentId)
        );

        replaceInCache(cache.appointments, appointment);

        return appointment;
    }

    // Returns the slots of one doctor on one date:
    // { doctorId, date, slotMinutes, slots: [{ time, state }] }
    // excludeAppointmentId treats that appointment's own slot as free.
    function loadAvailability(
        doctorId,
        date,
        excludeAppointmentId
    ) {
        return request(
            "GET",
            "/appointments/availability" +
                buildQuery({
                    doctorId,
                    date,
                    excludeAppointmentId
                })
        );
    }

    function createAppointment(input) {
        return attempt(
            async () => {
                const appointment = await request(
                    "POST",
                    "/appointments",
                    input
                );

                replaceInCache(
                    cache.appointments,
                    appointment
                );

                return appointment;
            },
            "appointment",
            "Appointment created."
        );
    }

    // Also used to reschedule. Changing the date, time or doctor of
    // a Booked appointment makes the server set it to Rescheduled.
    function updateAppointment(appointmentId, input) {
        return attempt(
            async () => {
                const appointment = await request(
                    "PUT",
                    "/appointments/" +
                        encodeURIComponent(appointmentId),
                    input
                );

                replaceInCache(
                    cache.appointments,
                    appointment
                );

                return appointment;
            },
            "appointment",
            "Appointment updated."
        );
    }

    // Cancelled appointments are kept, not deleted, so the
    // cancellation analytics keep their history.
    function cancelAppointment(appointmentId, reason, extra) {
        return attempt(
            async () => {
                const appointment = await request(
                    "POST",
                    "/appointments/" +
                        encodeURIComponent(appointmentId) +
                        "/cancel",
                    { ...(extra || {}), reason }
                );

                replaceInCache(
                    cache.appointments,
                    appointment
                );

                return appointment;
            },
            "appointment",
            appointmentId + " cancelled."
        );
    }

    // status: "Completed" or "No-show"
    function setAppointmentStatus(appointmentId, status) {
        return attempt(
            async () => {
                const appointment = await request(
                    "PATCH",
                    "/appointments/" +
                        encodeURIComponent(appointmentId) +
                        "/status",
                    { status }
                );

                replaceInCache(
                    cache.appointments,
                    appointment
                );

                return appointment;
            },
            "appointment",
            appointmentId + " marked " + status + "."
        );
    }

    // ============================================
    // APPOINTMENT HELPERS
    // ============================================

    function getAppointmentStart(appointment) {
        return combineDateTime(
            appointment.date,
            appointment.time
        );
    }

    function isClosed(appointment) {
        return Boolean(
            appointment &&
            CLOSED_STATUSES.includes(appointment.status)
        );
    }

    function canEdit(appointment) {
        return Boolean(appointment) && !isClosed(appointment);
    }

    function canCancel(appointment) {
        return canEdit(appointment);
    }

    // Completed or No-show can only be set once the time has passed.
    function canMarkOutcome(appointment) {
        return (
            canEdit(appointment) &&
            getAppointmentStart(appointment).getTime() <=
                Date.now()
        );
    }

    function isUpcoming(appointment) {
        return (
            canEdit(appointment) &&
            getAppointmentStart(appointment).getTime() >
                Date.now()
        );
    }

    // A booked appointment becomes Rescheduled when its doctor,
    // date or time changes (the server applies the same rule).
    function willBeRescheduled(existing, input) {
        if (!existing || !input) return false;

        if (existing.status !== "Booked") return false;

        return (
            existing.doctorId !== input.doctorId ||
            existing.date !== input.date ||
            existing.time !== input.time
        );
    }

    function getStatusBadge(status) {
        return STATUS_BADGES[status] || "badge-inactive";
    }

    function getDoctorStatusBadge(status) {
        return DOCTOR_BADGES[status] || "badge-inactive";
    }

    function getBlockBadge(type) {
        return BLOCK_BADGES[type] || "badge-inactive";
    }

    function getAvailabilityBadge(state) {
        return AVAILABILITY_BADGES[state] || "badge-inactive";
    }

    // Returns { valid, errors: { field: message } }
    function validateAppointmentInput(input, options) {
        const errors = {};
        const data = input || {};
        const editing = Boolean(options && options.editing);

        if (!String(data.patientId || "").trim()) {
            errors.patientId = "Enter the patient ID.";
        }

        if (!String(data.patientName || "").trim()) {
            errors.patientName = "Enter the patient name.";
        }

        if (!data.department) {
            errors.department = "Select a department.";
        }

        if (!data.doctorId) {
            errors.doctorId = "Select a doctor.";
        }

        if (!data.date) {
            errors.date = "Select a date.";
        } else if (!editing && data.date < todayISO()) {
            errors.date = "The date cannot be in the past.";
        }

        if (!data.time) {
            errors.time = "Select a time slot.";
        }

        if (data.email && !isValidEmail(data.email)) {
            errors.email = "Enter a valid email address.";
        }

        return {
            valid: Object.keys(errors).length === 0,
            errors
        };
    }

    // ============================================
    // SLOT HELPERS
    // ============================================

    // Only free slots can be picked.
    // Other states: booked, ot, leave, other.
    function isSlotSelectable(slot) {
        return Boolean(slot) && slot.state === "free";
    }

    function getSlotLabel(slot) {
        const labels = {
            booked: "Already booked",
            ot: "Doctor in OT",
            leave: "Doctor on leave",
            other: "Doctor unavailable"
        };

        return labels[slot && slot.state] || "";
    }

    // Splits slots into morning (before 12:00) and afternoon.
    function groupSlotsBySession(slots) {
        const groups = { morning: [], afternoon: [] };

        (slots || []).forEach(slot => {
            if (timeToMinutes(slot.time) < 12 * 60) {
                groups.morning.push(slot);
            } else {
                groups.afternoon.push(slot);
            }
        });

        return groups;
    }

    function getFreeSlots(slots) {
        return (slots || []).filter(isSlotSelectable);
    }

    // ============================================
    // DASHBOARD
    // ============================================

    function loadDashboardSummary() {
        return request("GET", "/dashboard/summary");
    }

    // ============================================
    // ANALYTICS
    // ============================================

    // Last N days ending yesterday, like the analytics pages.
    function getPeriodRange(days) {
        const end = new Date();
        end.setDate(end.getDate() - 1);

        const start = new Date(end);
        start.setDate(start.getDate() - (Number(days) - 1));

        return {
            dateFrom: toISODate(start),
            dateTo: toISODate(end)
        };
    }

    // filters: { dateFrom, dateTo, department, groupBy }
    function loadAppointmentDemand(filters) {
        return request(
            "GET",
            "/analytics/appointment-demand" +
                buildQuery(filters)
        );
    }

    // filters: { dateFrom, dateTo, department, doctorId }
    function loadPeakPeriods(filters) {
        return request(
            "GET",
            "/analytics/peak-periods" + buildQuery(filters)
        );
    }

    // filters: { dateFrom, dateTo, department }
    function loadDoctorUtilisation(filters) {
        return request(
            "GET",
            "/analytics/doctor-utilisation" +
                buildQuery(filters)
        );
    }

    // filters: { dateFrom, dateTo, department }
    function loadCancellations(filters) {
        return request(
            "GET",
            "/analytics/cancellations" + buildQuery(filters)
        );
    }

    // Returns a rounded percentage, or null when there is
    // no earlier figure to compare with.
    function percentChange(current, previous) {
        if (!previous) return null;

        return Math.round(
            (current - previous) / previous * 100
        );
    }

    // Booked slots / available slots, as a whole percent.
    function utilisationPercent(booked, available) {
        if (!available) return 0;

        return Math.round(booked / available * 100);
    }

    function utilisationLoad(percent) {
        if (percent < UTILISATION_LOW) {
            return {
                label: "Underused",
                badge: "badge-pending",
                bar: "pending"
            };
        }

        if (percent > UTILISATION_HIGH) {
            return {
                label: "High load",
                badge: "badge-overdue",
                bar: "overdue"
            };
        }

        return {
            label: "Healthy",
            badge: "badge-completed",
            bar: "completed"
        };
    }

    // ============================================
    // TIME FORMATTING
    // ============================================

    function formatTime(value) {
        if (!value) return "--";

        // "09:30" from the API is already a time of day.
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(value))) {
            return minutesToTime(timeToMinutes(value));
        }

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "--";
        }

        return date.toLocaleTimeString(
            "en-MY",
            {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: TIME_ZONE
            }
        );
    }

    function formatDate(value) {
        if (!value) return "--";

        // Plain dates are formatted as local dates to avoid
        // shifting the day through time zone conversion.
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
            ? new Date(value + "T00:00")
            : new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "--";
        }

        return date.toLocaleDateString(
            "en-GB",
            {
                day: "2-digit",
                month: "short",
                year: "numeric"
            }
        );
    }

    function formatDateTime(value) {
        if (!value) return "--";

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "--";
        }

        return date.toLocaleString(
            "en-MY",
            {
                dateStyle: "short",
                timeStyle: "short",
                timeZone: TIME_ZONE
            }
        );
    }

    function formatRelativeTime(value) {
        if (!value) return "";

        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            return "";
        }

        const difference = Math.max(
            0,
            Date.now() - date.getTime()
        );

        const minutes = Math.floor(
            difference / 60000
        );

        if (minutes < 1) {
            return "Just now";
        }

        if (minutes === 1) {
            return "1 min";
        }

        if (minutes < 60) {
            return `${minutes} min`;
        }

        const hours = Math.floor(minutes / 60);

        if (hours === 1) {
            return "1 hr";
        }

        if (hours < 24) {
            return `${hours} hrs`;
        }

        const days = Math.floor(hours / 24);

        return days === 1
            ? "1 day"
            : `${days} days`;
    }

    // ============================================
    // PUBLIC AMS FUNCTIONS
    // ============================================

    return {
        // Constants
        API_BASE,
        TIME_ZONE,
        APPOINTMENT_STATUSES,
        CLOSED_STATUSES,
        DOCTOR_STATUSES,
        BLOCK_TYPES,
        CANCEL_REASONS,
        DAYS,
        SLOT_LENGTHS,
        DEFAULT_SLOT_MINUTES,

        // Errors
        AmsError,
        getErrorMessage,

        // Session and auth
        getSession,
        isLoggedIn,
        clearSession,
        login,
        logout,

        // Departments
        loadDepartments,
        getDepartments,
        normalizeDepartment,
        getDepartmentByName,
        getDepartmentFromUrl,

        // Doctors
        loadDoctors,
        getDoctors,
        getDoctorById,
        fetchDoctor,
        getBookableDoctors,
        createDoctor,
        updateDoctor,
        setDoctorStatus,
        uploadDoctorPhoto,
        getDoctorInitials,
        validateDoctorInput,

        // Consultation hours
        getDefaultConsultationHours,
        loadConsultationHours,
        saveConsultationHours,
        countSessionSlots,
        countDaySlots,
        validateConsultationHours,

        // OT, leave and other blocks
        loadUnavailability,
        addUnavailability,
        removeUnavailability,
        validateUnavailabilityInput,
        blocksOverlap,
        appointmentsOverlappingBlock,

        // Appointments
        loadAppointments,
        getAppointments,
        getAppointmentById,
        fetchAppointment,
        loadAvailability,
        createAppointment,
        updateAppointment,
        cancelAppointment,
        setAppointmentStatus,
        validateAppointmentInput,

        // Appointment helpers
        getAppointmentStart,
        isClosed,
        canEdit,
        canCancel,
        canMarkOutcome,
        isUpcoming,
        willBeRescheduled,
        getStatusBadge,
        getDoctorStatusBadge,
        getBlockBadge,
        getAvailabilityBadge,

        // Slots
        isSlotSelectable,
        getSlotLabel,
        groupSlotsBySession,
        getFreeSlots,

        // Dashboard and analytics
        loadDashboardSummary,
        getPeriodRange,
        loadAppointmentDemand,
        loadPeakPeriods,
        loadDoctorUtilisation,
        loadCancellations,
        percentChange,
        utilisationPercent,
        utilisationLoad,

        // Time
        todayISO,
        toISODate,
        timeToMinutes,
        minutesToTime,
        combineDateTime,
        formatTime,
        formatDate,
        formatDateTime,
        formatRelativeTime
    };
})();