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