/* ====================================================================
   Analytics.js - chart helpers only
   Shared by AppointmentDemand.html, PeakPeriods.html and DoctorUtilisation.html

   The sample data generator that used to be here (AppData) has been
   removed. The pages now load their figures from the backend through
   AMS (ams.js + ams-api.js), already totalled by PostgreSQL.

   Labels and texts passed to these helpers are escaped here, so
   department and doctor names from the database are safe to pass in.
   ==================================================================== */
(function () {
    "use strict";

    const esc = value => String(value === undefined || value === null ? "" : value)
        .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

    function niceStep(x) {
        const p = Math.pow(10, Math.floor(Math.log10(x || 1)));
        const n = x / p;
        return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
    }

    const Charts = {

        // Horizontal bars. items: [{ label, value, text, cls }]
        hbars: function (container, items) {
            const max = Math.max(1, ...items.map(i => i.value));
            container.innerHTML = items.map(i =>
                '<div class="progress-row">' +
                    '<div class="progress-meta"><span>' + esc(i.label) + '</span><strong>' + esc(i.text) + '</strong></div>' +
                    '<div class="progress-track"><div class="progress-fill ' + esc(i.cls || "") + '" style="width:' + (i.value / max * 100).toFixed(1) + '%;"></div></div>' +
                '</div>').join("");
        },

        // Column chart. items: [{ label, value, highlight }]
        columns: function (container, items) {
            const max = Math.max(1, ...items.map(i => i.value));
            container.innerHTML =
                '<div class="bar-chart">' + items.map(i =>
                    '<div class="bar-col"><span class="bar-value">' + esc(i.value) + '</span>' +
                    '<div class="bar' + (i.highlight ? " today" : "") + '" style="height:' + (i.value / max * 80).toFixed(1) + '%;"></div></div>').join("") +
                '</div>' +
                '<div class="bar-labels">' + items.map(i => '<span>' + esc(i.label) + '</span>').join("") + '</div>';
        },

        // Line chart with a light area fill. labels and values have the same length.
        line: function (container, labels, values, ariaLabel) {
            if (!values.length) {
                container.innerHTML = '<p class="method-note">No data for this period.</p>';
                return;
            }

            const W = 640, H = 230, L = 40, R = 12, T = 12, B = 30;
            const max = Math.max(1, ...values);
            const step = niceStep(max / 4);
            const top = Math.ceil(max / step) * step;
            const x = i => L + (values.length === 1 ? 0 : i * (W - L - R) / (values.length - 1));
            const y = v => T + (H - T - B) * (1 - v / top);

            let grid = "";
            for (let v = 0; v <= top; v += step) {
                grid += '<line x1="' + L + '" y1="' + y(v) + '" x2="' + (W - R) + '" y2="' + y(v) + '" stroke="#e2e8f0" stroke-width="1"/>' +
                        '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="11" fill="#6b7280">' + v + '</text>';
            }

            const every = Math.ceil(values.length / 8);
            let xl = "";
            labels.forEach((lab, i) => {
                if (i % every === 0) xl += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#6b7280">' + esc(lab) + '</text>';
            });

            const pts = values.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1));
            const area = "M" + x(0).toFixed(1) + "," + y(0) + " L" + pts.join(" L") + " L" + x(values.length - 1).toFixed(1) + "," + y(0) + " Z";
            const dots = values.length <= 31
                ? values.map((v, i) => '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="3" fill="#1677ff"><title>' + esc(labels[i]) + ": " + v + '</title></circle>').join("")
                : "";

            container.innerHTML =
                '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(ariaLabel || "Trend chart") + '">' +
                grid + xl +
                '<path d="' + area + '" fill="rgba(22,119,255,0.12)"/>' +
                '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#1677ff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
                dots + '</svg>';
        },

        // Heatmap. matrix[row][col] holds numbers.
        heatmap: function (container, rowLabels, colLabels, matrix, unit) {
            let max = 1;
            matrix.forEach(r => r.forEach(v => { if (v > max) max = v; }));

            let html = '<div class="heatmap" style="grid-template-columns: 90px repeat(' + colLabels.length + ', 1fr);">' +
                       '<div></div>' + colLabels.map(c => '<div class="heat-colhead">' + esc(c) + '</div>').join("");

            rowLabels.forEach((rl, r) => {
                html += '<div class="heat-label">' + esc(rl) + '</div>';
                matrix[r].forEach((v, c) => {
                    const a = 0.08 + 0.92 * (v / max);
                    const color = a > 0.55 ? "#ffffff" : "#0f172a";
                    html += '<div class="heat-cell" style="background-color: rgba(22,119,255,' + a.toFixed(2) + '); color:' + color + ';" title="' +
                            esc(rl + " " + colLabels[c] + ": " + v + " " + unit) + '">' + v + '</div>';
                });
            });

            container.innerHTML = html + "</div>" +
                '<div class="heat-legend"><span>Fewer</span><span class="heat-gradient"></span><span>More</span></div>';
        },

        // "up 8%" style text. current and previous are numbers.
        change: function (current, previous) {
            if (!previous) return '<span class="trend-flat">no earlier data</span>';
            const pct = Math.round((current - previous) / previous * 100);
            if (pct > 0) return '<span class="trend-up">&#9650; ' + pct + '%</span> vs previous period';
            if (pct < 0) return '<span class="trend-down">&#9660; ' + Math.abs(pct) + '%</span> vs previous period';
            return '<span class="trend-flat">no change</span> vs previous period';
        }
    };

    window.Charts = Charts;
})();

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
            const esc = AMS_UI.esc;
 
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

    /* ------------------------------------------------------------------ */
            const el = id => document.getElementById(id);
        const esc = AMS_UI.esc;
 
        let ticket = 0;
 
        function fillDepartments() {
            el("dept").innerHTML = '<option value="">All departments</option>' +
                AMS.getDepartments().map(d => "<option>" + esc(d.name) + "</option>").join("");
        }
 
        function render(list, range) {
            el("rangeLabel").textContent = AMS.formatDate(range.dateFrom) + " to " + AMS.formatDate(range.dateTo);
 
            const rows = (list || []).map(r => {
                const booked = Number(r.bookedSlots) || 0;
                const free = Number(r.freeSlots) || 0;
                const blocked = Number(r.blockedSlots) || 0;
                const available = r.availableSlots !== undefined ? Number(r.availableSlots) : booked + free;
                const pct = r.utilisationPercent !== undefined ? Number(r.utilisationPercent) : AMS.utilisationPercent(booked, available);
 
                return { id: r.doctorId, name: r.doctorName, dept: r.department, booked, free, blocked, available, total: booked + free + blocked, pct };
            });
 
            if (!rows.length) {
                ["cAvg", "cHigh", "cLow", "cLost"].forEach(id => { el(id).textContent = "None"; el(id + "Label").textContent = "No doctors for this selection"; });
                el("stackRows").innerHTML = '<p class="method-note">No data for this period.</p>';
                el("utilRows").innerHTML = '<tr><td colspan="8">No data for this period.</td></tr>';
                el("insights").innerHTML = "";
                return;
            }
 
            /* ----- cards ----- */
            const sumBooked = rows.reduce((s, x) => s + x.booked, 0);
            const sumAvail = rows.reduce((s, x) => s + x.available, 0);
            const sumBlocked = rows.reduce((s, x) => s + x.blocked, 0);
            const sorted = rows.slice().sort((a, b) => b.pct - a.pct);
            const hi = sorted[0], lo = sorted[sorted.length - 1];
 
            el("cAvg").textContent = AMS.utilisationPercent(sumBooked, sumAvail) + "%";
            el("cAvgLabel").textContent = "Average utilisation, " + sumBooked + " of " + sumAvail + " slots";
            el("cHigh").textContent = hi.name;
            el("cHighLabel").textContent = "Most utilised, " + hi.pct + "%";
            el("cLow").textContent = lo.name;
            el("cLowLabel").textContent = "Least utilised, " + lo.pct + "%";
            el("cLost").textContent = sumBlocked;
            el("cLostLabel").textContent = "Slots lost to OT or leave";
 
            /* ----- stacked bars ----- */
            el("stackRows").innerHTML = rows.map(x => {
                const w = n => (x.total ? n / x.total * 100 : 0).toFixed(1);
 
                return '<div class="stack-row">' +
                    '<div class="progress-meta"><span>' + esc(x.name) + '</span><strong>' + x.pct + '% utilised</strong></div>' +
                    '<div class="stack-track" title="Booked ' + x.booked + ", free " + x.free + ", blocked " + x.blocked + '">' +
                    '<div class="stack-seg booked" style="width:' + w(x.booked) + '%;"></div>' +
                    '<div class="stack-seg free" style="width:' + w(x.free) + '%;"></div>' +
                    '<div class="stack-seg blocked" style="width:' + w(x.blocked) + '%;"></div></div></div>';
            }).join("");
 
            /* ----- table ----- */
            el("utilRows").innerHTML = sorted.map(x => {
                const l = AMS.utilisationLoad(x.pct);
 
                return "<tr>" +
                    "<td>" + esc(x.name) + '<span class="cell-sub">' + esc(x.id) + "</span></td>" +
                    "<td>" + esc(x.dept) + "</td>" +
                    "<td>" + x.available + "</td>" +
                    "<td>" + x.booked + "</td>" +
                    "<td>" + x.free + "</td>" +
                    "<td>" + x.blocked + "</td>" +
                    '<td><div class="util-cell"><div class="progress-track"><div class="progress-fill ' + l.bar + '" style="width:' + Math.min(100, x.pct) + '%;"></div></div><strong>' + x.pct + "%</strong></div></td>" +
                    '<td><span class="badge ' + l.badge + '">' + l.label + "</span></td>" +
                    "</tr>";
            }).join("");
 
            /* ----- insights ----- */
            const over = rows.filter(x => x.pct > 85);
            const under = rows.filter(x => x.pct < 50);
            const worstBlocked = rows.slice().sort((a, b) => b.blocked - a.blocked)[0];
            const out = [];
 
            if (over.length) out.push(["fa-arrow-trend-up", over.map(x => esc(x.name)).join(", ") + (over.length > 1 ? " are" : " is") + " above 85% utilised. Patients may struggle to find a slot, so consider adding sessions."]);
            if (under.length) out.push(["fa-arrow-trend-down", under.map(x => esc(x.name)).join(", ") + (under.length > 1 ? " are" : " is") + " below 50% utilised. Review their hours or promote their services."]);
            if (worstBlocked && worstBlocked.blocked > 0) out.push(["fa-ban", esc(worstBlocked.name) + " lost " + worstBlocked.blocked + " slots to OT or leave, the most of any doctor. Plan these blocks ahead so patients can be moved early."]);
            if (over.length && under.length && over[0].dept === under[0].dept) out.push(["fa-right-left", "Both busy and quiet doctors work in " + esc(over[0].dept) + ". Directing new bookings to " + esc(under[0].name) + " would balance the load."]);
            if (!out.length) out.push(["fa-circle-check", "All doctors are in the healthy range for this period."]);
 
            el("insights").innerHTML = out.map(i => '<li><i class="fa-solid ' + i[0] + '"></i><span>' + i[1] + "</span></li>").join("");
        }
 
        async function load() {
            const range = AMS.getPeriodRange(Number(el("period").value));
            const mine = ++ticket;
 
            try {
                const data = await AMS.loadDoctorUtilisation({
                    dateFrom: range.dateFrom,
                    dateTo: range.dateTo,
                    department: el("dept").value
                });
 
                if (mine !== ticket) return;
                AMS_UI.clearMessage();
                render(Array.isArray(data) ? data : (data && data.items) || [], range);
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

    /* ------------------------------------------------------------------ */
            const el = id => document.getElementById(id);
        const esc = AMS_UI.esc;
 
        const DAYS  = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const HOURS = [9, 10, 11, 14, 15, 16];
        const pad = n => String(n).padStart(2, "0");
        const hourLabel = h => pad(h) + ":00";
 
        let ticket = 0;
 
        async function fillFilters() {
            el("dept").innerHTML = '<option value="">All departments</option>' +
                AMS.getDepartments().map(d => "<option>" + esc(d.name) + "</option>").join("");
 
            await fillDoctors();
        }
 
        async function fillDoctors() {
            const keep = el("doctor").value;
            let list = [];
 
            try {
                list = (await AMS.loadDoctors({ department: el("dept").value, pageSize: 100 })).items;
            } catch (error) {
                AMS_UI.showError(error);
            }
 
            el("doctor").innerHTML = '<option value="">All doctors</option>' +
                list.map(d => '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>").join("");
 
            if (Array.from(el("doctor").options).some(o => o.value === keep)) el("doctor").value = keep;
        }
 
        // How many times each weekday occurs in the period, for "average per week"
        function weekdayCounts(from, to) {
            const counts = {};
            let c = AMS.combineDateTime(from, "00:00");
            const end = AMS.combineDateTime(to, "00:00");
 
            while (c <= end) {
                const name = DAYS[(c.getDay() + 6) % 7];
                counts[name] = (counts[name] || 0) + 1;
                c = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 1);
            }
 
            return counts;
        }
 
        function render(data, range) {
            el("rangeLabel").textContent = AMS.formatDate(range.dateFrom) + " to " + AMS.formatDate(range.dateTo);
 
            // matrix[day][hour] from the server's { dayOfWeek, hour, count } rows
            const matrix = DAYS.map(() => HOURS.map(() => 0));
            let any = 0;
 
            // The bridge may hand over the bare list when heatmap is the only field
            const cellsIn = Array.isArray(data) ? data : (data && data.heatmap) || [];
 
            cellsIn.forEach(cell => {
                const d = DAYS.indexOf(cell.dayOfWeek);
                const h = HOURS.indexOf(Number(cell.hour));
 
                if (d >= 0 && h >= 0) {
                    matrix[d][h] += Number(cell.count) || 0;
                    any += Number(cell.count) || 0;
                }
            });
 
            const dayTotals = matrix.map(row => row.reduce((s, v) => s + v, 0));
            const hourTotals = HOURS.map((h, hi) => matrix.reduce((s, row) => s + row[hi], 0));
            const argMax = arr => arr.indexOf(Math.max(...arr));
            const argMin = arr => arr.indexOf(Math.min(...arr));
 
            if (!any) {
                ["cDay", "cHour", "cSlot", "cQuiet"].forEach(id => {
                    el(id).textContent = "None";
                    el(id + "Label").textContent = "No data for this selection";
                });
                el("heatmap").innerHTML = '<p class="method-note">No appointments in this period.</p>';
                el("dayChart").innerHTML = el("hourChart").innerHTML = el("topRows").innerHTML = el("insights").innerHTML = "";
                return;
            }
 
            /* ----- cards ----- */
            const bd = argMax(dayTotals), bh = argMax(hourTotals), qd = argMin(dayTotals);
            let peak = { d: 0, h: 0, v: -1 };
            matrix.forEach((row, d) => row.forEach((v, h) => { if (v > peak.v) peak = { d: d, h: h, v: v }; }));
 
            el("cDay").textContent = DAYS[bd];
            el("cDayLabel").textContent = "Busiest day, " + dayTotals[bd] + " appointments";
            el("cHour").textContent = hourLabel(HOURS[bh]);
            el("cHourLabel").textContent = "Busiest hour, " + hourTotals[bh] + " appointments";
            el("cSlot").textContent = DAYS[peak.d].slice(0, 3) + " " + hourLabel(HOURS[peak.h]);
            el("cSlotLabel").textContent = "Peak slot, " + peak.v + " appointments";
            el("cQuiet").textContent = DAYS[qd];
            el("cQuietLabel").textContent = "Quietest day, " + dayTotals[qd] + " appointments";
 
            /* ----- charts ----- */
            Charts.heatmap(el("heatmap"), DAYS, HOURS.map(hourLabel), matrix, "appointments");
            Charts.columns(el("dayChart"), DAYS.map((n, i) => ({ label: n.slice(0, 3), value: dayTotals[i], highlight: i === bd })));
            Charts.columns(el("hourChart"), HOURS.map((h, i) => ({ label: hourLabel(h), value: hourTotals[i], highlight: i === bh })));
 
            /* ----- top 5 slots ----- */
            const counts = weekdayCounts(range.dateFrom, range.dateTo);
            const cells = [];
            matrix.forEach((row, d) => row.forEach((v, h) => cells.push({ d: d, h: h, v: v })));
            cells.sort((a, b) => b.v - a.v);
 
            el("topRows").innerHTML = cells.slice(0, 5).map((c, i) => {
                const weeks = counts[DAYS[c.d]] || 1;
 
                return "<tr><td>" + (i + 1) + "</td><td>" + DAYS[c.d] + "</td><td>" + hourLabel(HOURS[c.h]) + " to " + hourLabel(HOURS[c.h] + 1) +
                       "</td><td><strong>" + c.v + "</strong></td><td>" + (c.v / weeks).toFixed(1) + "</td></tr>";
            }).join("");
 
            /* ----- insights ----- */
            const weeksPeak = counts[DAYS[peak.d]] || 1;
            const lowSlot = cells[cells.length - 1];
            const insights = [
                ["fa-fire", DAYS[peak.d] + " " + hourLabel(HOURS[peak.h]) + " is the busiest slot, averaging " + (peak.v / weeksPeak).toFixed(1) + " appointments a week. Make sure enough doctors are scheduled then."],
                ["fa-arrows-left-right", "Demand on " + DAYS[bd] + " is " + (dayTotals[bd] / Math.max(1, dayTotals[qd])).toFixed(1) + " times that of " + DAYS[qd] + ". Shifting some bookings to quieter days would even out the load."],
                ["fa-clock", "The " + hourLabel(HOURS[argMin(hourTotals)]) + " hour is the quietest. It could suit longer or follow-up consultations."],
                ["fa-triangle-exclamation", "Avoid scheduling OT or leave in the busiest slots. Blocking " + DAYS[lowSlot.d] + " " + hourLabel(HOURS[lowSlot.h]) + " has the least impact."]
            ];
 
            el("insights").innerHTML = insights.map(i => '<li><i class="fa-solid ' + i[0] + '"></i><span>' + i[1] + "</span></li>").join("");
        }
 
        async function load() {
            const range = AMS.getPeriodRange(Number(el("period").value));
            const mine = ++ticket;
 
            try {
                const data = await AMS.loadPeakPeriods({
                    dateFrom: range.dateFrom,
                    dateTo: range.dateTo,
                    department: el("dept").value,
                    doctorId: el("doctor").value
                });
 
                if (mine !== ticket) return;
                AMS_UI.clearMessage();
                render(data || {}, range);
            } catch (error) {
                if (mine === ticket) AMS_UI.showError(error);
            }
        }
 
        el("period").addEventListener("change", load);
        el("doctor").addEventListener("change", load);
        el("dept").addEventListener("change", async () => { await fillDoctors(); load(); });
 
        (async function init() {
            if (!AMS_UI.initPage()) return;
 
            try {
                await AMS.loadDepartments();
                await fillFilters();
            } catch (error) {
                AMS_UI.showError(error);
            }
 
            load();
        })();