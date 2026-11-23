/* Doctors.js - doctor list for Doctors.html
   Load after ams.js, ams-api.js and ams-ui.js */
(function () {
    "use strict";

        const el = id => document.getElementById(id);
        const esc = AMS_UI.esc;
        const enc = encodeURIComponent;
        const PAGE_SIZE = 10;
        let currentPage = 1;
 
        let activeId = null;
 
        /* ---------- Filters ---------- */
        el("btnSearch").addEventListener("click", () => {
            currentPage = 1;
            AMS_UI.clearMessage();
            load();
        });

        el("filterSearch").addEventListener("keydown", e => {
            if (e.key === "Enter") {
                currentPage = 1;
                AMS_UI.clearMessage();
                load();
            }
        });

        el("btnReset").addEventListener("click", () => {

            ["filterSearch", "filterDept", "filterStatus"]
                .forEach(id => el(id).value = "");

            currentPage = 1;

            AMS_UI.clearMessage();
            load();
        });

        el("pagination").addEventListener("click", e => {

            const btn = e.target.closest("button[data-page]");

            if (!btn || btn.disabled) return;

            currentPage = Number(btn.dataset.page);

            load();
        });

        function currentFilters() {
        return {
                search: el("filterSearch").value.trim(),
                department: el("filterDept").value,
                status: el("filterStatus").value,
                page: currentPage,
                pageSize: PAGE_SIZE
            };
        }
 
        function fillDepartments() {
            el("filterDept").innerHTML =
                '<option value="">All departments</option>' +
                AMS.getDepartments().map(d => "<option>" + esc(d.name) + "</option>").join("");
        }
 
        /* ---------- Table ---------- */
        function avatarHtml(doctor) {
            if (doctor.photoUrl) {
                return '<div class="avatar" style="background-image:url(\'' +
                    esc(AMS_UI.assetUrl(doctor.photoUrl)) + '\')"></div>';
            }
 
            return '<div class="avatar">' + esc(AMS.getDoctorInitials(doctor.name)) + "</div>";
        }
 
        function rowHtml(d) {
            const toggle = d.status === "Inactive"
                ? '<button type="button" class="table-button" data-action="activate">Activate</button>'
                : '<button type="button" class="table-button danger" data-action="deactivate">Deactivate</button>';
 
            return '<tr data-id="' + esc(d.id) + '">' +
                '<td><div class="doctor-cell">' + avatarHtml(d) +
                    '<div><div class="doctor-name">' + esc(d.name) + '</div><span class="cell-sub">' + esc(d.id) + "</span></div></div></td>" +
                "<td>" + esc(d.specialty) + "</td>" +
                "<td>" + esc(d.department) + "</td>" +
                "<td>" + esc(d.phone) + '<span class="cell-sub">' + esc(d.email) + "</span></td>" +
                "<td>" + esc(d.upcomingAppointments || 0) + "</td>" +
                '<td><span class="badge ' + AMS.getDoctorStatusBadge(d.status) + '">' + esc(d.status) + "</span></td>" +
                '<td><div class="table-actions">' +
                    '<a href="DoctorProfile.html?id=' + enc(d.id) + '" class="table-button">Edit</a>' +
                    '<a href="DoctorSchedule.html?id=' + enc(d.id) + '" class="table-button">Schedule</a>' +
                    toggle +
                "</div></td></tr>";
        }

        function renderPagination(page) {
            const size = page.pageSize || PAGE_SIZE;
            const total = page.totalItems || 0;
            const pages = Math.max(1, Math.ceil(total / size));
            const from = total ? (page.page - 1) * size + 1 : 0;
            const to = Math.min(total, page.page * size);
 
            const first = Math.max(1, page.page - 2);
            const last = Math.min(pages, page.page + 2);
            let buttons = '<button type="button" class="page-button" data-page="' + (page.page - 1) + '"' +
                          (page.page <= 1 ? " disabled" : "") + ">Prev</button>";
 
            for (let p = first; p <= last; p++) {
                buttons += '<button type="button" class="page-button' + (p === page.page ? " current" : "") +
                           '" data-page="' + p + '">' + p + "</button>";
            }
 
            buttons += '<button type="button" class="page-button" data-page="' + (page.page + 1) + '"' +
                       (page.page >= pages ? " disabled" : "") + ">Next</button>";
 
            el("pagination").innerHTML =
                "<span>Showing " + from + " to " + to + " of " + total + "</span>" +
                '<div class="pagination-buttons">' + buttons + "</div>";
        }

 
        async function load() {
            el("emptyMessage").style.display = "none";

            el("doctorRows").innerHTML =
                '<tr><td colspan="7">Loading doctors...</td></tr>';

            try {
                const page = await AMS.loadDoctors(currentFilters());

                el("doctorRows").innerHTML =
                    page.items.map(rowHtml).join("");

                el("resultCount").textContent =
                    page.totalItems + " doctors";

                el("emptyMessage").style.display =
                    page.items.length ? "none" : "block";

                renderPagination(page);

            } catch (error) {
                el("doctorRows").innerHTML = "";
                el("resultCount").textContent = "";
                el("pagination").innerHTML = "";

                AMS_UI.showError(error);
            }
        }
 
        /* ---------- Activate and deactivate ---------- */
        const modal = el("statusModal");
 
        function openModal(doctor) {
            activeId = doctor.id;
            const upcoming = Number(doctor.upcomingAppointments || 0);
 
            el("statusSummary").textContent =
                doctor.name + " will no longer appear when booking appointments.";
 
            const blocked = upcoming > 0;
 
            if (blocked) {
                el("statusWarning").innerHTML =
                    esc(doctor.name) + " still has <strong>" + upcoming + " upcoming appointments</strong>. " +
                    'Reschedule or cancel them first in <a href="Appointments.html">All Appointments</a>.';
            }
 
            el("statusWarning").classList.toggle("show", blocked);
            el("statusConfirm").disabled = blocked;
            el("statusConfirm").style.opacity = blocked ? "0.5" : "";
            el("statusConfirm").style.cursor = blocked ? "not-allowed" : "";
 
            modal.classList.add("open");
            el("statusClose").focus();
        }
 
        function closeModal() {
            modal.classList.remove("open");
            activeId = null;
        }
 
        el("doctorRows").addEventListener("click", async e => {
            const btn = e.target.closest("button[data-action]");
            if (!btn) return;
 
            const doctor = AMS.getDoctorById(btn.closest("tr").dataset.id);
            if (!doctor) return;
 
            if (btn.dataset.action === "deactivate") {
                openModal(doctor);
                return;
            }
 
            btn.disabled = true;
            const result = await AMS.setDoctorStatus(doctor.id, "Active");
            AMS_UI.message(result.success ? "success" : "error",
                result.success ? doctor.name + " is active again." : result.message);
            load();
        });
 
        el("statusClose").addEventListener("click", closeModal);
        modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
        document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
 
        el("statusConfirm").addEventListener("click", async () => {
            if (!activeId || el("statusConfirm").disabled) return;
 
            const doctor = AMS.getDoctorById(activeId);
            el("statusConfirm").disabled = true;
 
            // Doctors are deactivated, not deleted, so past appointments keep their doctor.
            const result = await AMS.setDoctorStatus(activeId, "Inactive");
 
            if (result.success) {
                closeModal();
                AMS_UI.message("success", doctor.name + " has been deactivated.");
                load();
                return;
            }
 
            // The server refuses while upcoming appointments exist
            if (result.upcomingAppointments) {
                el("statusWarning").innerHTML =
                    esc(doctor.name) + " has <strong>" + Number(result.upcomingAppointments) +
                    " upcoming appointments</strong>. " +
                    'Reschedule or cancel them first in <a href="Appointments.html">All Appointments</a>.';
                el("statusWarning").classList.add("show");
            } else {
                closeModal();
                AMS_UI.message("error", result.message);
            }
        });
 
        /* ---------- Start ---------- */
        (async function init() {
            AMS_UI.initPage();
 
            try {
                await AMS.loadDepartments();
            } catch (error) {
                AMS_UI.showError(error);
            }
 
            fillDepartments();
            load();
        })();


})();