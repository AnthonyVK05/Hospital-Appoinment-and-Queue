/*
    Load order on every page:
        <script src="ams.js"></script>
        <script src="ams-api.js"></script>
        <script src="ams-ui.js"></script>

    What the bridge handles, so the backend can stay close to the QMS style:
      - base URL: "/api" when the page is served by Express (like qms-api.js),
        or http://localhost:3000/api when opened from VS Code Live Server.
        Override with window.AMS_API_BASE before ams.js.
      - JWT in sessionStorage ("amsToken"), sent as a Bearer token
      - response envelopes, any of these are accepted:
            { success: true, appointments: [...] }       (QMS style, one key)
            { success: true, appointments: [...], page, pageSize, totalItems }
            { success: true, data: {...} }
            plain JSON with no "success" (the OpenAPI shape)
        and { success: false, message } for errors
      - snake_case keys from PostgreSQL rows become camelCase
        (patient_name -> patientName), so routes may return raw rows
      - DATE and timestamp values are turned into the plain values
        ams.js uses, always in Asia/Kuala_Lumpur time, so the result
        does not depend on the server or browser time zone:
            "date" / "dateOfBirth" / "...Date" keys  -> "YYYY-MM-DD"
            appointments with scheduledAt but no
            date/time                                -> date + "HH:MM"
      - raw rows from the Neon tables get the field names ams.js reads
        (only when that field is missing, so a route that already
        returns the final shape is never changed):
            departments   departmentName      -> name
            doctors       doctorId            -> id
                          fullName            -> name
                          isActive            -> status (Active / Inactive)
            joined rows   departmentName      -> department
        Joins that raw rows cannot carry (the department name on a
        doctor, the patient name and email on an appointment) must
        still be done in the route's SQL.
      - 401 clears the session and redirects to login.html
        (change it with window.AMS_LOGIN_PAGE, or set "" to switch it off)
*/

(() => {
    "use strict";

    if (typeof AMS === "undefined") {
        console.error("ams-api.js must be loaded after ams.js");
        return;
    }

    const base = AMS.API_BASE;

    const TIME_ZONE =
        AMS.TIME_ZONE ||
        window.AMS_TIME_ZONE ||
        "Asia/Kuala_Lumpur";

    const token = () =>
        sessionStorage.getItem("amsToken");

    // ============================================
    // TIME ZONE HELPERS
    // ============================================

    // hourCycle h23 keeps midnight as "00" instead of "24".
    const zonedFormatter = new Intl.DateTimeFormat(
        "en-GB",
        {
            timeZone: TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }
    );

    function zonedParts(date) {
        const parts = {};

        zonedFormatter
            .formatToParts(date)
            .forEach(part => {
                parts[part.type] = part.value;
            });

        return parts;
    }

    // "YYYY-MM-DD" as seen in TIME_ZONE
    function zonedDate(date) {
        const parts = zonedParts(date);

        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    // "HH:MM" (24-hour) as seen in TIME_ZONE
    function zonedTime(date) {
        const parts = zonedParts(date);

        return `${parts.hour}:${parts.minute}`;
    }

    // ============================================
    // RESPONSE MAPPING
    // ============================================

    const toCamel = key =>
        key.replace(
            /_([a-z0-9])/g,
            (match, character) => character.toUpperCase()
        );

    const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

    // Keys that hold a calendar date (a PostgreSQL DATE column).
    // Real timestamps such as scheduledAt or createdAt are kept as
    // they are, because ams.js formats those itself.
    function isDateKey(key) {
        return (
            key === "date" ||
            key === "dateOfBirth" ||
            /[a-z]Date$/.test(key || "")
        );
    }

    // node-postgres turns a DATE column into a JavaScript Date, which
    // reaches the browser as a timestamp ("2026-10-19T16:00:00.000Z").
    // Read it back as a calendar date in the clinic's time zone.
    function fixDate(value) {
        if (
            typeof value === "string" &&
            ISO_TIMESTAMP.test(value)
        ) {
            const date = new Date(value);

            if (!Number.isNaN(date.getTime())) {
                return zonedDate(date);
            }
        }

        return value;
    }

    const has = (record, key) =>
        record[key] !== undefined && record[key] !== null;

    // Gives a raw Neon row the field names ams.js reads.
    // Nothing that is already present is overwritten.
    function adaptRecord(record) {
        // departments: id, departmentCode, departmentName, ...
        const isDepartment =
            has(record, "departmentName") &&
            has(record, "departmentCode") &&
            !has(record, "departmentId") &&
            !has(record, "doctorId") &&
            !has(record, "scheduledAt");

        if (isDepartment) {
            if (!has(record, "name")) {
                record.name = record.departmentName;
            }
        } else if (
            has(record, "departmentName") &&
            !has(record, "department")
        ) {
            // A row joined to departments (doctor, appointment).
            record.department = record.departmentName;
        }

        // doctors: doctorId, fullName, specialty, isActive, ...
        const isDoctor =
            has(record, "doctorId") &&
            has(record, "fullName") &&
            has(record, "specialty");

        if (isDoctor) {
            if (!has(record, "id")) {
                record.id = record.doctorId;
            }

            if (!has(record, "name")) {
                record.name = record.fullName;
            }

            // "On leave" is not stored on the doctors table.
            // The route has to send status itself when it applies.
            if (
                !has(record, "status") &&
                typeof record.isActive === "boolean"
            ) {
                record.status = record.isActive
                    ? "Active"
                    : "Inactive";
            }
        }

        // appointments: one timestamp (scheduledAt) in the table,
        // separate date and time in ams.js.
        if (
            typeof record.scheduledAt === "string" &&
            ISO_TIMESTAMP.test(record.scheduledAt)
        ) {
            const scheduled = new Date(record.scheduledAt);

            if (!Number.isNaN(scheduled.getTime())) {
                if (!has(record, "date")) {
                    record.date = zonedDate(scheduled);
                }

                if (!has(record, "time")) {
                    record.time = zonedTime(scheduled);
                }
            }
        }

        return record;
    }

    function camelize(value, key) {
        if (Array.isArray(value)) {
            return value.map(item => camelize(item));
        }

        if (value && typeof value === "object") {
            const result = {};

            Object.keys(value).forEach(name => {
                const camelName = toCamel(name);

                result[camelName] = camelize(
                    value[name],
                    camelName
                );
            });

            return adaptRecord(result);
        }

        return isDateKey(key)
            ? fixDate(value)
            : value;
    }

    // Removes the { success, message } wrapper so ams.js
    // always receives the plain data.
    function unwrap(body) {
        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !("success" in body)
        ) {
            return body;
        }

        const rest = { ...body };

        delete rest.success;
        delete rest.message;

        // Keep authentication session information intact.
        if ("session" in rest) {
            return rest;
        }

        if ("data" in rest) {
            return rest.data;
        }

        const keys = Object.keys(rest);

        // { success, doctors: [...] }
        // { success, appointment: {...} }
        if (
            keys.length === 1 &&
            rest[keys[0]] !== null &&
            typeof rest[keys[0]] === "object"
        ) {
            return rest[keys[0]];
        }

        // { success, appointments: [...], page, pageSize, totalItems }
        const arrayKey = keys.find(
            name => Array.isArray(rest[name])
        );

        if (arrayKey && !("items" in rest)) {
            return {
                ...rest,
                items: rest[arrayKey]
            };
        }

        return rest;
    }

    // ============================================
    // REQUEST
    // ============================================

    function handleUnauthorized(status, path) {
        if (
            status !== 401 ||
            path.startsWith("/auth/login")
        ) {
            return;
        }

        AMS.clearSession();

        // login.html is the default. Set window.AMS_LOGIN_PAGE = ""
        // to turn the redirect off.
        const loginPage =
            typeof window.AMS_LOGIN_PAGE === "string"
                ? window.AMS_LOGIN_PAGE
                : "login.html";

        if (
            loginPage &&
            !location.pathname.endsWith("/" + loginPage)
        ) {
            location.replace(loginPage);
        }
    }

    async function request(method, path, body) {
        const headers = {
            Accept: "application/json"
        };

        const options = {
            method,
            headers
        };

        if (body instanceof FormData) {
            // The browser sets the multipart boundary.
            options.body = body;
        } else if (body !== undefined) {
            headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }

        if (token()) {
            headers.Authorization = `Bearer ${token()}`;
        }

        let response;

        try {
            response = await fetch(base + path, options);
        } catch (error) {
            throw new AMS.AmsError(
                "Cannot reach the server. " +
                "Check that the backend is running.",
                0,
                "NETWORK_ERROR"
            );
        }

        if (response.status === 204) {
            return null;
        }

        let data;

        try {
            data = await response.json();
        } catch {
            throw new AMS.AmsError(
                "Invalid server response",
                response.status,
                "INVALID_RESPONSE"
            );
        }

        data = camelize(data);

        const failed =
            !response.ok ||
            (
                data &&
                typeof data === "object" &&
                data.success === false
            );

        if (failed) {
            handleUnauthorized(response.status, path);

            throw new AMS.AmsError(
                (data && (data.message || data.error)) ||
                    `Request failed: ${response.status}`,
                response.status,
                data && data.code,
                data && data.details,
                data
            );
        }

        return unwrap(data);
    }

    const get = path =>
        request("GET", path);

    const post = (path, body) =>
        request("POST", path, body);

    // Quick check from the browser console: await AMS_API.health()
    const health = () =>
        get("/health");

    window.AMS_API = {
        base,
        request,
        get,
        post,
        health,
        camelize,
        unwrap
    };
})();