/* PeakPeriods.js - script for PeakPeriods.html
   Load after ams.js, ams-api.js and Analytics.js */
(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const esc = AMS_UI.esc;
    let ticket = 0;   // ignores answers that arrive after a newer request

        const DAYS  = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const HOURS = [9, 10, 11, 14, 15, 16];
        const pad = n => String(n).padStart(2, "0");
        const hourLabel = h => pad(h) + ":00";
 
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
})();
