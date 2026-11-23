/* DoctorSchedule.js - schedule and availability
   Used by DoctorSchedule.html (and by Doctors.html, which has the same section)
   Load after ams.js, ams-api.js and ams-ui.js */
(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const esc = AMS_UI.esc;

        const params = new URLSearchParams(location.search);
 
        let doctorId = params.get("id");
        let blocks = [];
 
        /* ---------- Messages inside the page ---------- */
        function showMessage(id, type, html) {
            const box = el(id);
            box.className = "message-box show " + type;
            box.innerHTML = html;
        }
 
        function hideMessage(id) {
            el(id).className = "message-box";
        }
 
        // "2026-10-20T09:30" shown as local date and time
        function fmt(value) {
            const d = new Date(value);
 
            if (Number.isNaN(d.getTime())) return "--";
 
            return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + " " +
                   d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        }
 
        function listAppointments(items) {
            return items.map(a => esc(a.id) + " (" + esc(AMS.formatDate(a.date)) + " " + esc(AMS.formatTime(a.time)) + ")").join(", ");
        }
 
        /* ---------- Weekly consultation hours ---------- */
        function buildHoursTable(hours) {
            const tbody = document.querySelector("#hoursTable tbody");
            tbody.innerHTML = "";
            el("slotLength").value = String(hours.slotMinutes || AMS.DEFAULT_SLOT_MINUTES);
 
            hours.days.forEach(d => {
                const m = d.morning || { start: "", end: "" };
                const a = d.afternoon || { start: "", end: "" };
                const tr = document.createElement("tr");
                tr.dataset.day = d.day;
 
                tr.innerHTML =
                    '<td><label class="day-cell"><input type="checkbox" class="day-on"' + (d.working ? " checked" : "") + "> " + esc(d.day) + "</label></td>" +
                    '<td><div class="time-range"><input type="time" class="time-input m-start" value="' + esc(m.start || "") + '"> to <input type="time" class="time-input m-end" value="' + esc(m.end || "") + '"></div><div class="row-error m-error"></div></td>' +
                    '<td><div class="time-range"><input type="time" class="time-input a-start" value="' + esc(a.start || "") + '"> to <input type="time" class="time-input a-end" value="' + esc(a.end || "") + '"></div><div class="row-error a-error"></div></td>' +
                    '<td class="slot-count"></td>';
 
                tbody.appendChild(tr);
 
                tr.querySelectorAll("input").forEach(input => {
                    input.addEventListener("input", () => updateRow(tr));
                    input.addEventListener("change", () => updateRow(tr));
                });
 
                updateRow(tr);
            });
        }
 
        function readRow(tr) {
            const working = tr.querySelector(".day-on").checked;
 
            const session = prefix => {
                const start = tr.querySelector("." + prefix + "-start").value;
                const end = tr.querySelector("." + prefix + "-end").value;
                return start || end ? { start, end } : null;
            };
 
            return {
                day: tr.dataset.day,
                working,
                morning: working ? session("m") : null,
                afternoon: working ? session("a") : null
            };
        }
 
        function updateRow(tr) {
            const on = tr.querySelector(".day-on").checked;
            tr.querySelectorAll(".time-input").forEach(i => i.disabled = !on);
 
            const row = readRow(tr);
            const count = AMS.countDaySlots(row, Number(el("slotLength").value));
            tr.querySelector(".slot-count").textContent = on ? count + " slots" : "Not working";
        }
 
        function collectHours() {
            return {
                slotMinutes: Number(el("slotLength").value),
                days: Array.from(document.querySelectorAll("#hoursTable tbody tr")).map(readRow)
            };
        }
 
        async function loadHours() {
            let hours;
            let usedDefaults = false;
 
            try {
                hours = await AMS.loadConsultationHours(doctorId);
            } catch (error) {
                if (error.status !== 404) throw error;
                hours = null;
            }
 
            if (!hours || !Array.isArray(hours.days) || !hours.days.length) {
                hours = AMS.getDefaultConsultationHours();
                usedDefaults = true;
            }
 
            buildHoursTable(hours);
 
            if (usedDefaults) {
                showMessage("hoursMessage", "warning", "No consultation hours are saved for this doctor yet. These are the default hours. Save to keep them.");
            } else {
                hideMessage("hoursMessage");
            }
        }
 
        el("slotLength").addEventListener("change", () => {
            document.querySelectorAll("#hoursTable tbody tr").forEach(updateRow);
        });
 
        el("saveHours").addEventListener("click", async () => {
            const hours = collectHours();
            const check = AMS.validateConsultationHours(hours);
 
            document.querySelectorAll("#hoursTable .row-error").forEach(n => n.textContent = "");
 
            if (!check.valid) {
                check.errors.forEach(err => {
                    if (!err.day) return;
                    const tr = document.querySelector('#hoursTable tr[data-day="' + err.day + '"]');
                    if (tr) tr.querySelector(err.session === "afternoon" ? ".a-error" : ".m-error").textContent = err.message;
                });
 
                const general = check.errors.filter(err => !err.day).map(err => esc(err.message)).join(" ");
                showMessage("hoursMessage", "error", general || "Fix the highlighted rows before saving.");
                return;
            }
 
            el("saveHours").disabled = true;
            const result = await AMS.saveConsultationHours(doctorId, hours);
            el("saveHours").disabled = false;
 
            if (!result.success) {
                showMessage("hoursMessage", "error", esc(result.message));
                return;
            }
 
            if (result.affectedAppointments.length) {
                showMessage("hoursMessage", "warning",
                    "<strong>Hours saved.</strong> " + result.affectedAppointments.length +
                    " booked appointment(s) now fall outside these hours: " + listAppointments(result.affectedAppointments) +
                    '. <a href="Appointments.html?filter=conflict">Reschedule them</a>.');
            } else {
                showMessage("hoursMessage", "success", "Consultation hours saved.");
            }
        });
 
        el("resetHours").addEventListener("click", async () => {
            try {
                await loadHours();
            } catch (error) {
                showMessage("hoursMessage", "error", esc(AMS.getErrorMessage(error)));
            }
        });
 
        /* ---------- OT, leave and other blocks ---------- */
        function renderBlocks() {
            const tbody = document.querySelector("#blockTable tbody");
 
            tbody.innerHTML = blocks.map(b => {
                const hits = Number(b.affectedAppointments || 0);
 
                return "<tr>" +
                    '<td><span class="badge ' + AMS.getBlockBadge(b.type) + '">' + esc(b.type) + "</span></td>" +
                    "<td>" + esc(fmt(b.from)) + "</td>" +
                    "<td>" + esc(fmt(b.to)) + "</td>" +
                    "<td>" + (esc(b.note) || "-") + "</td>" +
                    "<td>" + (hits
                        ? '<a href="Appointments.html?filter=conflict" class="action-link">' + hits + " to reschedule</a>"
                        : "None") + "</td>" +
                    '<td><button type="button" class="table-button danger" data-id="' + esc(b.id) + '">Remove</button></td>' +
                    "</tr>";
            }).join("");
 
            el("blockEmpty").style.display = blocks.length ? "none" : "block";
        }
 
        async function loadBlocks() {
            const data = await AMS.loadUnavailability(doctorId, { from: AMS.todayISO() });
            blocks = Array.isArray(data) ? data : (data && data.items) || [];
            blocks.sort((a, b) => new Date(a.from) - new Date(b.from));
            renderBlocks();
        }
 
        el("blockTable").addEventListener("click", async e => {
            const btn = e.target.closest("button[data-id]");
            if (!btn) return;
 
            btn.disabled = true;
 
            // Removing a block frees those slots for booking again
            const result = await AMS.removeUnavailability(doctorId, btn.dataset.id);
 
            if (result.success) {
                hideMessage("blockMessage");
                try { await loadBlocks(); } catch (error) { showMessage("blockMessage", "error", esc(AMS.getErrorMessage(error))); }
            } else {
                btn.disabled = false;
                showMessage("blockMessage", "error", esc(result.message));
            }
        });
 
        el("startDate").min = AMS.todayISO();
        el("endDate").min = AMS.todayISO();
 
        el("startDate").addEventListener("change", () => {
            if (!el("endDate").value || el("endDate").value < el("startDate").value) {
                el("endDate").value = el("startDate").value;
            }
            el("endDate").min = el("startDate").value;
        });
 
        function syncAllDay() {
            const all = el("allDay").checked;
            el("startTime").disabled = all;
            el("endTime").disabled = all;
        }
 
        el("allDay").addEventListener("change", syncAllDay);
 
        el("blockType").addEventListener("change", () => {
            if (el("blockType").value === "Leave") el("allDay").checked = true;
            syncAllDay();
        });
 
        el("addBlock").addEventListener("click", async () => {
            const all = el("allDay").checked;
            const sd = el("startDate").value, ed = el("endDate").value;
 
            const input = {
                type: el("blockType").value,
                from: sd && sd + "T" + (all ? "00:00" : el("startTime").value),
                to: ed && ed + "T" + (all ? "23:59" : el("endTime").value),
                note: el("blockNote").value.trim(),
                notifyAffected: el("notifyAffected").checked
            };
 
            const check = AMS.validateUnavailabilityInput(input);
 
            if (!check.valid) {
                showMessage("blockMessage", "error", esc(check.errors.range || check.errors.type));
                return;
            }
 
            if (blocks.some(b => AMS.blocksOverlap(input, b))) {
                showMessage("blockMessage", "error", "This overlaps an existing block for this doctor.");
                return;
            }
 
            el("addBlock").disabled = true;
            const result = await AMS.addUnavailability(doctorId, input);
            el("addBlock").disabled = false;
 
            if (!result.success) {
                showMessage("blockMessage", "error", esc(result.message));
                return;
            }
 
            const hits = result.affectedAppointments;
 
            if (hits.length) {
                showMessage("blockMessage", "warning",
                    "<strong>" + hits.length + " booked appointment" + (hits.length > 1 ? "s" : "") +
                    " overlap this block:</strong> " + listAppointments(hits) + ". " +
                    '<a href="Appointments.html?filter=conflict">Reschedule them</a>.');
            } else {
                showMessage("blockMessage", "success", "Block added. No booked appointments are affected.");
            }
 
            el("blockNote").value = "";
 
            try { await loadBlocks(); } catch (error) { showMessage("blockMessage", "error", esc(AMS.getErrorMessage(error))); }
        });
 
        /* ---------- Doctor selector ---------- */
        function initials(name) {
            return AMS.getDoctorInitials(name);
        }
 
        async function loadDoctorData() {
            try {
                await Promise.all([loadHours(), loadBlocks()]);
            } catch (error) {
                AMS_UI.showError(error);
            }
        }
 
        /* ---------- Start ---------- */
        (async function init() {
            AMS_UI.initPage();
 
            let doctors = [];
 
            try {
                doctors = (await AMS.loadDoctors({ pageSize: 100 })).items;
            } catch (error) {
                AMS_UI.showError(error);
                return;
            }
 
            if (!doctors.length) {
                AMS_UI.message("warning", "There are no doctors yet. Add a doctor first.");
                return;
            }
 
            if (!doctors.some(d => d.id === doctorId)) doctorId = doctors[0].id;
 
            el("doctorSelect").innerHTML = doctors.map(d =>
                '<option value="' + esc(d.id) + '">' + esc(d.name) + " (" + esc(d.department) + ")</option>").join("");
            el("doctorSelect").value = doctorId;
            el("doctorSelect").addEventListener("change", () => {
                location.search = "?id=" + encodeURIComponent(el("doctorSelect").value);
            });
 
            const doctor = AMS.getDoctorById(doctorId);
            el("doctorAvatar").textContent = initials(doctor.name);
            el("doctorMeta").textContent = doctor.id + ", " + doctor.department + ", " + doctor.status;
 
            loadDoctorData();
        })();


})();
