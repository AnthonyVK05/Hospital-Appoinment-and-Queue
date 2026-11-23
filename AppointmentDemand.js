/* AppointmentDemand.js - script for AppointmentDemand.html
   Load after ams.js, ams-api.js and Analytics.js */
(function () {
    "use strict";

    const esc = AMS_UI.esc;

        const el = id => document.getElementById(id);
 
        let ticket = 0;   // ignores answers that arrive after a newer request
 
        function fillDepartments() {
            el("dept").innerHTML = '<option value="">All departments</option>' +
                AMS.getDepartments().map(d => "<option>" + AMS_UI.esc(d.name) + "</option>").join("");
        }
 
        function topOf(list, key) {
            return list.slice().sort((a, b) => b[key] - a[key])[0];
        }
 
        function render(data, days) {
            const total = data.total || 0;
            const byDept = data.byDepartment || [];
            const byDoc = data.byDoctor || [];
            const range = AMS.getPeriodRange(days);
 
            el("rangeLabel").textContent = AMS.formatDate(range.dateFrom) + " to " + AMS.formatDate(range.dateTo);
 
            /* ----- cards ----- */
            el("cTotal").textContent = total;
            el("cTotalLabel").innerHTML = "Total appointments<br>" + Charts.change(total, data.previousTotal || 0);
            el("cAvg").textContent = Number(data.averagePerDay || 0).toFixed(1);
            el("cAvgLabel").textContent = "Average per day";
 
            const topDept = byDept.length ? topOf(byDept, "count") : null;
            const topDoc = byDoc.length ? topOf(byDoc, "count") : null;
 
            el("cDept").textContent = topDept ? topDept.name : "None";
            el("cDeptLabel").textContent = topDept ? "Busiest department, " + topDept.count + " appointments" : "Busiest department";
            el("cDoctor").textContent = topDoc ? topDoc.doctorName : "None";
            el("cDoctorLabel").textContent = topDoc ? "Busiest doctor, " + topDoc.count + " appointments" : "Busiest doctor";
 
            /* ----- trend (daily up to 30 days, weekly for 90) ----- */
            const trend = data.trend || [];
            el("trendTitle").textContent = days > 30 ? "Appointments per week" : "Appointments per day";
            Charts.line(el("trendChart"), trend.map(t => t.label || AMS.formatDate(t.date)), trend.map(t => t.count), "Appointments over time");
 
            /* ----- department bars ----- */
            const deptItems = byDept.slice().sort((a, b) => b.count - a.count).map(d => ({
                label: d.name, value: d.count, text: d.count + " (" + (total ? Math.round(d.count / total * 100) : 0) + "%)"
            }));
 
            if (deptItems.length) Charts.hbars(el("deptBars"), deptItems);
            else el("deptBars").innerHTML = '<p class="method-note">No appointments in this period.</p>';
 
            /* ----- doctor table ----- */
            const docs = byDoc.slice().sort((a, b) => b.count - a.count);
            const maxDoc = Math.max(1, ...docs.map(d => d.count));
 
            el("doctorRows").innerHTML = docs.length ? docs.map((d, i) => {
                const share = total ? Math.round(d.count / total * 100) : 0;
 
                return "<tr>" +
                    "<td>" + (i + 1) + "</td>" +
                    "<td>" + esc(d.doctorName) + '<span class="cell-sub">' + esc(d.doctorId) + "</span></td>" +
                    "<td>" + esc(d.department) + "</td>" +
                    "<td><strong>" + esc(d.count) + "</strong></td>" +
                    '<td><div class="util-cell"><div class="progress-track"><div class="progress-fill" style="width:' + (d.count / maxDoc * 100).toFixed(1) + '%;"></div></div><strong>' + share + "%</strong></div></td>" +
                    "<td>" + Charts.change(d.count, d.previousCount || 0).replace(" vs previous period", "") + "</td>" +
                    "</tr>";
            }).join("") : '<tr><td colspan="6">No appointments in this period.</td></tr>';
        }
 
        async function load() {
            const days = Number(el("period").value);
            const range = AMS.getPeriodRange(days);
            const mine = ++ticket;
 
            try {
                const data = await AMS.loadAppointmentDemand({
                    dateFrom: range.dateFrom,
                    dateTo: range.dateTo,
                    department: el("dept").value,
                    groupBy: days > 30 ? "week" : "day"
                });
 
                if (mine !== ticket) return;
                AMS_UI.clearMessage();
                render(data || {}, days);
            } catch (error) {
                if (mine === ticket) AMS_UI.showError(error);
            }
        }
 
        el("period").addEventListener("change", load);
        el("dept").addEventListener("change", load);
 
        (async function init() {
            if (!AMS_UI.initPage()) return;
 
            try {
                await AMS.loadDepartments();
                fillDepartments();
            } catch (error) {
                AMS_UI.showError(error);
            }
 
            load();
        })();

})();
