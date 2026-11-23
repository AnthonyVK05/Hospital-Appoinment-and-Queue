
        const el = id => document.getElementById(id);
        const esc = AMS_UI.esc;
        const enc = encodeURIComponent;
 
        const PAGE_SIZE = 20;
        const params = new URLSearchParams(location.search);
 
        // ?filter=conflict (from the dashboard) lists only appointments
        // that clash with a doctor's OT, leave or other block.
        let conflictOnly =
            params.get("filter") === "conflict" ||
            params.get("conflict") === "true";
 
        let currentPage = 1;
        let activeId = null;
 
        /* ---------- Filters ---------- */
        function currentFilters(page) {
            return {
                search: el("filterSearch").value.trim(),
                status: el("filterStatus").value,
                department: el("filterDept").value,
                doctorId: el("filterDoctor").value,
                dateFrom: el("filterFrom").value,
                dateTo: el("filterTo").value,
                conflict: conflictOnly ? "true" : "",
                page: page || 1,
                pageSize: PAGE_SIZE
            };
        }
 
        function fillFilters() {
            el("filterDept").innerHTML =
                '<option value="">All departments</option>' +
                AMS.getDepartments().map(d =>
                    "<option>" + esc(d.name) + "</option>").join("");
 
            el("filterDoctor").innerHTML =
                '<option value="">All doctors</option>' +
                AMS.getDoctors().map(d =>
                    '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>").join("");
        }
 
        /* ---------- Table ---------- */
        function rowHtml(a) {
            const actions = [];
 
            if (AMS.canEdit(a)) {
                actions.push(
                    '<a href="AppointmentForm.html?id=' + enc(a.id) + '" class="table-button">' +
                    (a.hasConflict ? "Reschedule" : "Edit") + "</a>");
 
                if (AMS.canMarkOutcome(a)) {
                    actions.push('<button type="button" class="table-button" data-action="complete">Done</button>');
                    actions.push('<button type="button" class="table-button" data-action="noshow">No-show</button>');
                }
 
                actions.push('<button type="button" class="table-button danger" data-action="cancel">Cancel</button>');
            } else {
                actions.push(
                    '<a href="AppointmentForm.html?id=' + enc(a.id) + '" class="table-button">View</a>');
            }
 
            const flag = a.hasConflict
                ? ' <i class="fa-solid fa-triangle-exclamation conflict-flag" title="Clashes with the doctor\'s OT, leave or other block"></i>'
                : "";
 
            return '<tr data-id="' + esc(a.id) + '">' +
                "<td>" + esc(a.id) + "</td>" +
                "<td>" + esc(a.patientName) + '<span class="cell-sub">' + esc(a.patientId) + "</span></td>" +
                "<td>" + esc(a.department) + "</td>" +
                "<td>" + esc(a.doctorName || a.doctorId) + "</td>" +
                "<td>" + esc(AMS.formatDate(a.date)) + "</td>" +
                "<td>" + esc(AMS.formatTime(a.time)) + flag + "</td>" +
                '<td><span class="badge ' + AMS.getStatusBadge(a.status) + '">' + esc(a.status) + "</span></td>" +
                '<td><div class="table-actions">' + actions.join("") + "</div></td>" +
                "</tr>";
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
 
        function renderTable(page) {
            el("appointmentRows").innerHTML = page.items.map(rowHtml).join("");
            el("resultCount").textContent = page.totalItems + " appointments";
            el("emptyMessage").style.display = page.items.length ? "none" : "block";
            renderPagination(page);
        }

        el("pagination").addEventListener("click", e => {

            const btn = e.target.closest("button[data-page]");

            if (!btn || btn.disabled) return;

            currentPage = Number(btn.dataset.page);

            load();
        });
 
        async function load(page) {
            currentPage = page || 1;
            el("emptyMessage").style.display = "none";
            el("appointmentRows").innerHTML = '<tr><td colspan="8">Loading appointments...</td></tr>';
 
            try {
                renderTable(await AMS.loadAppointments(currentFilters(currentPage)));
            } catch (error) {
                el("appointmentRows").innerHTML = "";
                el("resultCount").textContent = "";
                el("pagination").innerHTML = "";
                AMS_UI.showError(error);
            }
        }
 
        el("btnSearch").addEventListener("click", () => { AMS_UI.clearMessage(); load(1); });
        el("filterSearch").addEventListener("keydown", e => { if (e.key === "Enter") { AMS_UI.clearMessage(); load(1); } });
 
        el("btnReset").addEventListener("click", () => {
            ["filterSearch", "filterStatus", "filterDept", "filterDoctor", "filterFrom", "filterTo"]
                .forEach(id => el(id).value = "");
 
            conflictOnly = false;
            history.replaceState(null, "", location.pathname);
            AMS_UI.clearMessage();
            load(1);
        });
 
        el("pagination").addEventListener("click", e => {
            const btn = e.target.closest("button[data-page]");
            if (btn && !btn.disabled) load(Number(btn.dataset.page));
        });
 
        /* ---------- Row actions ---------- */
        const modal = el("cancelModal");
 
        function openModal(appointment) {
            activeId = appointment.id;
 
            el("cancelSummary").textContent =
                appointment.id + " for " + appointment.patientName +
                " with " + (appointment.doctorName || appointment.doctorId) +
                " on " + AMS.formatDate(appointment.date) + ", " +
                AMS.formatTime(appointment.time) + ".";
 
            modal.classList.add("open");
            el("cancelConfirm").focus();
        }
 
        function closeModal() {
            modal.classList.remove("open");
            activeId = null;
        }
 
        el("appointmentRows").addEventListener("click", async e => {
            const btn = e.target.closest("button[data-action]");
            if (!btn) return;
 
            const id = btn.closest("tr").dataset.id;
            const appointment = AMS.getAppointmentById(id);
            if (!appointment) return;
 
            if (btn.dataset.action === "cancel") {
                openModal(appointment);
                return;
            }
 
            const status = btn.dataset.action === "complete" ? "Completed" : "No-show";
            if (!confirm("Mark " + id + " as " + status + "?")) return;
 
            btn.disabled = true;
            const result = await AMS.setAppointmentStatus(id, status);
            AMS_UI.message(result.success ? "success" : "error", result.message);
            load(currentPage);
        });
 
        el("cancelClose").addEventListener("click", closeModal);
        modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
        document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
 
        el("cancelConfirm").addEventListener("click", async () => {
            if (!activeId) return;
 
            const id = activeId;
            el("cancelConfirm").disabled = true;
 
            // The appointment is kept with status Cancelled, so the
            // cancellation analytics keep their history.
            const result = await AMS.cancelAppointment(id, el("cancelReason").value, {
                notifyPatient: el("cancelNotify").checked
            });
 
            el("cancelConfirm").disabled = false;
            closeModal();
            AMS_UI.message(result.success ? "success" : "error", result.message);
            load(currentPage);
        });
 
        /* ---------- Start ---------- */
        (async function init() {
            AMS_UI.initPage();
 
            try {
                await Promise.all([
                    AMS.loadDepartments(),
                    AMS.loadDoctors({ pageSize: 100 })
                ]);
            } catch (error) {
                AMS_UI.showError(error);
            }
 
            fillFilters();
            load(1);
        })();
