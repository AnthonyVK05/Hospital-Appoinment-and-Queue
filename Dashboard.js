const el = id => document.getElementById(id);
        const esc = AMS_UI.esc;
        const enc = encodeURIComponent;
 
        const ATTENTION = {
            OtClash:            { cls: "warning", icon: "fa-triangle-exclamation", link: "Appointments.html?filter=conflict", text: "Review" },
            FailedNotification: { cls: "danger",  icon: "fa-circle-exclamation",   link: "NotificationLog.html?status=failed", text: "Resend" },
            Unconfirmed:        { cls: "info",    icon: "fa-hourglass-half",       link: "NotificationCenter.html",            text: "Send reminder" }
        };
 
        function percent(value) {
            const n = Number(value || 0);
            return (Math.round(n * 10) / 10) + "%";
        }

        const requiredElements = [
            "cToday",
            "cUpcoming",
            "cCancel",
            "cDuty",
            "cNotif",
            "scheduleRows",
            "availabilityList",
            "attentionList",
            "deptBars",
            "trendChart"
        ];

        requiredElements.forEach(id => {
            const element = document.getElementById(id);

            if (!element) {
                console.error("Missing HTML element:", id);
            }
        });
 
        /* ---------- Pieces ---------- */
        function renderCards(s) {
            el("cToday").textContent = s.todaysAppointments || 0;
            el("cUpcoming").textContent = s.upcomingNext7Days || 0;
            el("cCancel").textContent = s.cancellationsToday || 0;
            el("cDuty").textContent = (s.doctorsOnDuty || 0) + " / " + (s.doctorsTotal || 0);
 
            // The notification card only shows when the server sends notification figures
            const hasNotifications = s.notificationsSentToday !== undefined && s.notificationsSentToday !== null;
            el("cardNotif").style.display = hasNotifications ? "" : "none";
 
            if (hasNotifications) {
                el("cNotif").textContent = s.notificationsSentToday;
                el("cNotifLabel").textContent = "Notifications sent, " + (s.notificationsFailedToday || 0) + " failed";
            }
        }
 
        function renderSchedule(list) {
            const rows = list || [];
 
            if (!rows.length) {
                el("scheduleRows").innerHTML = '<tr><td colspan="6">No appointments today.</td></tr>';
                return;
            }
 
            el("scheduleRows").innerHTML = rows.map(a => {
                const link = AMS.canEdit(a)
                    ? '<a href="AppointmentForm.html?id=' + enc(a.id) + '" class="action-link">Edit</a>'
                    : '<a href="AppointmentForm.html?id=' + enc(a.id) + '" class="action-link">View</a>';
 
                return "<tr>" +
                    "<td>" + esc(AMS.formatTime(a.time)) + "</td>" +
                    "<td>" + esc(a.patientName) + "</td>" +
                    "<td>" + esc(a.doctorName || a.doctorId) + "</td>" +
                    "<td>" + esc(a.department) + "</td>" +
                    '<td><span class="badge ' + AMS.getStatusBadge(a.status) + '">' + esc(a.status) + "</span></td>" +
                    "<td>" + link + "</td></tr>";
            }).join("");
        }
 
        function renderAvailability(list) {
            const rows = list || [];
 
            if (!rows.length) {
                el("availabilityList").innerHTML = '<li class="availability-row"><div class="availability-meta">No doctors to show.</div></li>';
                return;
            }
 
            el("availabilityList").innerHTML = rows.map(d =>
                '<li class="availability-row"><div>' +
                    '<div class="availability-name">' + esc(d.doctorName) + "</div>" +
                    '<div class="availability-meta">' + esc(d.department) + (d.note ? ", " + esc(d.note) : "") + "</div></div>" +
                    '<span class="badge ' + AMS.getAvailabilityBadge(d.state) + '">' + esc(d.state) + "</span></li>").join("");
        }
 
        function renderAttention(list) {
            const items = list || [];
 
            if (!items.length) {
                el("attentionList").innerHTML =
                    '<li class="attention-row info"><i class="fa-solid fa-circle-check"></i>' +
                    '<div class="attention-text">Nothing needs attention right now.</div></li>';
                return;
            }
 
            el("attentionList").innerHTML = items.map(item => {
                const kind = ATTENTION[item.kind] || { cls: "info", icon: "fa-circle-info", link: "", text: "" };
 
                return '<li class="attention-row ' + kind.cls + '"><i class="fa-solid ' + kind.icon + '"></i>' +
                    '<div class="attention-text">' + esc(item.message) + "</div>" +
                    (kind.link ? '<a href="' + kind.link + '" class="action-link">' + kind.text + "</a>" : "") + "</li>";
            }).join("");
        }
 
        function renderDepartments(list) {
            const rows = list || [];
 
            if (!rows.length) {
                el("deptBars").innerHTML = '<p class="method-note">No appointments this week.</p>';
                return;
            }
 
            const max = Math.max(1, ...rows.map(r => r.count));
 
            el("deptBars").innerHTML = rows.map(r =>
                '<div class="progress-row"><div class="progress-meta"><span>' + esc(r.name) + "</span><strong>" + esc(r.count) + "</strong></div>" +
                '<div class="progress-track"><div class="progress-fill" style="width:' + (r.count / max * 100).toFixed(1) + '%;"></div></div></div>').join("");
        }
 
        function renderTrend(list) {
            const days = list || [];
 
            if (!days.length) {
                el("trendChart").innerHTML = '<p class="method-note">No data for the last 7 days.</p>';
                return;
            }
 
            const max = Math.max(1, ...days.map(d => d.booked));
            const today = AMS.todayISO();
 
            const bars = days.map(d => {
                const booked = Math.max(d.booked ? 2 : 0, d.booked / max * 100);
                const cancelled = Math.max(d.cancelled ? 2 : 0, d.cancelled / max * 100);
 
                return '<div class="bar-col"><div class="bar-pair">' +
                    '<div class="bar' + (d.date === today ? " today" : "") + '" style="height:' + booked.toFixed(1) + '%;" title="Booked: ' + esc(d.booked) + '"></div>' +
                    '<div class="bar cancelled" style="height:' + cancelled.toFixed(1) + '%;" title="Cancelled: ' + esc(d.cancelled) + '"></div></div></div>';
            }).join("");
 
            const labels = days.map(d => {
                if (d.date === today) return "<span>Today</span>";
 
                const date = new Date(d.date + "T00:00");
                return "<span>" + date.toLocaleDateString("en-GB", { weekday: "short" }) + "</span>";
            }).join("");
 
            el("trendChart").innerHTML =
                '<div class="bar-chart">' + bars + "</div>" +
                '<div class="bar-labels">' + labels + "</div>" +
                '<div class="chart-legend">' +
                    '<span class="legend-item"><span class="legend-swatch" style="background-color: #92bdfa;"></span> Booked</span>' +
                    '<span class="legend-item"><span class="legend-swatch" style="background-color: #f87171;"></span> Cancelled</span></div>';
        }
 
        /* ---------- Load ---------- */
        async function load() {
            try {
                const summary = await AMS.loadDashboardSummary();

                // routes/dashboard.js must send todaysAppointments,
                // todaysSchedule, doctorAvailability and the other figures
                // listed there. A reply without them means the old
                // dashboard route (appointments / patients / queues
                // totals) is still the one running.
                if (!summary || summary.todaysAppointments === undefined) {
                    AMS_UI.message(
                        "error",
                        "The dashboard route returned an unexpected format. " +
                        "Replace routes/dashboard.js with the new version " +
                        "and restart the server."
                    );
                    return;
                }
 
                renderCards(summary);
                renderSchedule(summary.todaysSchedule);
                renderAvailability(summary.doctorAvailability);
                renderAttention(summary.needsAttention);
                renderDepartments(summary.appointmentsByDepartment);
                renderTrend(summary.bookedVsCancelledLast7Days);
 
                AMS_UI.clearMessage();
            } catch (error) {
                AMS_UI.showError(error);
            }
        }
 
        AMS_UI.initPage();
        load();
 
        // Refresh the figures every minute while the page is open
        setInterval(load, 60000);