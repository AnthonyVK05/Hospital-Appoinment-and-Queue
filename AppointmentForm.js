const el = id => document.getElementById(id);
const esc = AMS_UI.esc;
const params = new URLSearchParams(location.search);
const editId = params.get("id");

let existing = null;     // the appointment being edited, if any
let isEditing = false;
let readOnly = false;    // Completed, Cancelled and No-show are closed
let slotRequest = 0;     // ignores slot responses that arrive late

const hm = value => String(value || "").slice(0, 5);

/* ---------- Dropdowns ---------- */
function fillDepartments(selected) {
    el("department").innerHTML =
        '<option value="">Select department</option>' +
        AMS.getDepartments().map(d =>
            "<option>" + esc(d.name) + "</option>").join("");

    if (selected) el("department").value = selected;
}

function fillDoctors(department, selectedId) {
    const select = el("doctor");
    const doctors = AMS.getBookableDoctors(department)
        .map(d => ({ id: d.id, name: d.name }));

    // Keep the current doctor visible when editing, even if inactive now.
    if (existing && selectedId === existing.doctorId &&
        !doctors.some(d => d.id === selectedId)) {
        doctors.push({ id: existing.doctorId, name: existing.doctorName || existing.doctorId });
    }

    if (!department) {
        select.innerHTML = '<option value="">Select department first</option>';
        select.disabled = true;
        return;
    }

    select.disabled = false;
    select.innerHTML = '<option value="">Select doctor</option>' +
        doctors.map(d => '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>").join("");

    if (selectedId) select.value = selectedId;
}

/* ---------- Time slots ---------- */
function updateSlotText() {
    const value = el("slot").value;
    el("slotSelected").textContent = value ? "Selected time: " + value : "";
}

function selectSlot(time) {
    el("slot").value = time;
    document.querySelectorAll(".slot").forEach(b =>
        b.classList.toggle("selected", b.dataset.time === time));
    el("slotError").style.display = "none";
    updateSlotText();
}

async function renderSlots() {
    const area = el("slotArea");
    const doctorId = el("doctor").value;
    const date = el("date").value;

    if (readOnly) {
        area.innerHTML = '<p class="slot-hint">This appointment is ' +
            esc(existing.status.toLowerCase()) + " and its time can no longer be changed.</p>";
        el("slotSelected").textContent = "Time: " + AMS.formatTime(existing.time);
        el("slotLegend").style.display = "none";
        return;
    }

    if (!doctorId || !date) {
        area.innerHTML = '<p class="slot-hint">Choose a doctor and date to see available time slots.</p>';
        el("slot").value = "";
        updateSlotText();
        return;
    }

    const ticket = ++slotRequest;
    area.innerHTML = '<p class="slot-hint">Loading time slots...</p>';

    let data;

    try {
        // The server marks each slot free, booked, ot, leave or other.
        // The appointment's own slot is treated as free while editing.
        data = await AMS.loadAvailability(doctorId, date, existing ? existing.id : "");
    } catch (error) {
        if (ticket !== slotRequest) return;
        area.innerHTML = '<p class="slot-hint">' + esc(AMS.getErrorMessage(error)) + "</p>";
        el("slot").value = "";
        updateSlotText();
        return;
    }

    if (ticket !== slotRequest) return;

    const slots = (data.slots || []).map(s => ({ time: hm(s.time), state: s.state }));

    if (!slots.length) {
        area.innerHTML = '<p class="slot-hint">This doctor has no consultation hours on this date.</p>';
        el("slot").value = "";
        updateSlotText();
        return;
    }

    const groups = AMS.groupSlotsBySession(slots);
    area.innerHTML = "";

    [["Morning", groups.morning], ["Afternoon", groups.afternoon]].forEach(pair => {
        if (!pair[1].length) return;

        const title = document.createElement("div");
        title.className = "slot-group-label";
        title.textContent = pair[0];
        area.appendChild(title);

        const grid = document.createElement("div");
        grid.className = "slot-grid";

        pair[1].forEach(slot => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "slot" + (slot.state === "ot" || slot.state === "leave" || slot.state === "other" ? " ot" : "");
            btn.textContent = slot.time;
            btn.dataset.time = slot.time;

            if (AMS.isSlotSelectable(slot)) {
                btn.addEventListener("click", () => selectSlot(slot.time));
            } else {
                btn.disabled = true;
                btn.title = AMS.getSlotLabel(slot);
            }

            grid.appendChild(btn);
        });

        area.appendChild(grid);
    });

    // Keep the selection only if that slot is still free
    const current = el("slot").value;
    const stillFree = slots.some(s => s.time === current && AMS.isSlotSelectable(s));

    if (stillFree) selectSlot(current);
    else { el("slot").value = ""; updateSlotText(); }
}

/* ---------- Form ---------- */
function gatherInput() {
    return {
        patientId: el("patientId").value.trim(),
        patientName: el("patientName").value.trim(),
        phone: el("phone").value.trim(),
        email: el("email").value.trim(),
        department: el("department").value,
        doctorId: el("doctor").value,
        date: el("date").value,
        time: el("slot").value,
        notes: el("notes").value.trim(),
        notes: el("notes").value.trim(),
    };
}

function setFieldError(id, message) {
    const field = el(id).closest(".field");
    field.classList.toggle("invalid", Boolean(message));

    const text = field.querySelector(".form-error");
    if (message && text) text.textContent = message;
}

function showBanner(text) {
    el("bannerText").textContent = text;
    el("banner").style.display = "flex";
}

el("department").addEventListener("change", () => {
    fillDoctors(el("department").value);
    el("slot").value = "";
    renderSlots();
});

el("doctor").addEventListener("change", renderSlots);
el("date").addEventListener("change", renderSlots);

el("appointmentForm").addEventListener("submit", async e => {
    e.preventDefault();

    const input = gatherInput();
    const check = AMS.validateAppointmentInput(input, { editing: isEditing });
    const errors = { ...check.errors };

    // Notifications need a way to reach the patient
    if (input.notifyPatient && !input.phone && !input.email && !errors.email) {
        errors.email = "Add a phone number or email to send notifications.";
    }

    setFieldError("patientId", errors.patientId);
    setFieldError("patientName", errors.patientName);
    setFieldError("department", errors.department);
    setFieldError("doctor", errors.doctorId);
    setFieldError("date", errors.date);
    setFieldError("email", errors.email);
    el("slotError").style.display = errors.time ? "block" : "none";

    if (Object.keys(errors).length) {
        const first = document.querySelector(".field.invalid");
        if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }

    const rescheduled = isEditing && AMS.willBeRescheduled(existing, input);
    el("saveButton").disabled = true;

    const result = isEditing
        ? await AMS.updateAppointment(existing.id, input)
        : await AMS.createAppointment(input);

    if (result.success) {
        AMS_UI.message("success",
            isEditing ? (rescheduled ? "Appointment rescheduled." : "Appointment updated.")
                        : "Appointment " + result.appointment.id + " created.");
        setTimeout(() => { location.href = "Appointments.html"; }, 900);
        return;
    }

    el("saveButton").disabled = false;
    AMS_UI.message("error", result.message);

    // A taken or blocked slot: refresh the slots so the picker is current
    if (result.status === 409) {
        el("slot").value = "";
        renderSlots();
    }
});

/* ---------- Start ---------- */
(async function init() {
    AMS_UI.initPage();

    try {
        await Promise.all([
            AMS.loadDepartments(),
            AMS.loadDoctors({ status: "Active", pageSize: 100 })
        ]);

        if (editId) existing = await AMS.fetchAppointment(editId);
    } catch (error) {
        AMS_UI.showError(error);

        if (editId && !existing) {
            el("formFields").disabled = true;
            el("saveButton").disabled = true;
            return;
        }
    }

    fillDepartments();

    if (existing) {
        isEditing = true;
        readOnly = AMS.isClosed(existing);

        el("pageTitle").textContent = (readOnly ? "Appointment " : "Edit appointment ") + existing.id;
        el("pageSubtitle").textContent = readOnly
            ? "This record is closed. You can view it but not change it."
            : "Change the details or pick a new slot to reschedule.";
        el("notifyLabel").textContent = "Notify the patient about this change";

        el("patientId").value = existing.patientId || "";
        el("patientId").readOnly = true;
        el("patientName").value = existing.patientName || "";
        el("phone").value = existing.phone || "";
        el("email").value = existing.email || "";

        fillDepartments(existing.department);
        fillDoctors(existing.department, existing.doctorId);
        el("date").value = existing.date;
        el("notes").value = existing.notes || "";

        // The status changes through Cancel, Reschedule or Done / No-show, not here.
        el("statusField").style.display = "block";
        el("status").value = existing.status;
        el("status").disabled = true;

        el("slot").value = hm(existing.time);

        if (readOnly) {
            el("formFields").disabled = true;
            el("formActions").innerHTML =
                '<a href="Appointments.html" class="action-button secondary">Back to appointments</a>';
        } else if (existing.hasConflict) {
            showBanner("This appointment clashes with the doctor's OT, leave or other block. " +
                        "Pick a new time slot or date, then save to reschedule.");
        }
    } else {
        el("date").min = AMS.todayISO();
    }

    renderSlots();
})();
