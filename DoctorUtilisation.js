/* DoctorUtilisation.js - script for DoctorUtilisation.html
   Load after ams.js, ams-api.js and Analytics.js */
(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const esc = AMS_UI.esc;
    let ticket = 0;   // ignores answers that arrive after a newer request

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

})();
