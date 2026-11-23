/* DoctorProfile.js - add / edit doctor for DoctorProfile.html
   Load after ams.js, ams-api.js and ams-ui.js */
(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const esc = AMS_UI.esc;
    const params = new URLSearchParams(location.search);

        const editId = params.get("id");
 
        let existing = null;
        let photoUrl = "";       // preview of a newly chosen photo
        let savedPhotoUrl = "";  // photo already stored on the server
 
        /* ---------- Avatar and summary ---------- */
        function setAvatar(node, text) {
            const url = photoUrl || savedPhotoUrl;
 
            if (url) {
                node.style.backgroundImage = "url('" + url.replace(/'/g, "%27") + "')";
                node.textContent = "";
            } else {
                node.style.backgroundImage = "";
                node.textContent = text;
            }
        }
 
        function refreshSummary() {
            const name = el("fullName").value.trim();
            const department = el("department").value;
            const specialty = el("specialty").value.trim();
            const status = el("status").value;
            const initials = name ? AMS.getDoctorInitials(name) : "?";
 
            el("summaryName").textContent = name || "New doctor";
            el("summaryRole").textContent = [specialty, department].filter(Boolean).join(", ") || "Department and specialty";
            el("summaryRoom").textContent = el("room").value.trim() || "Not set";
            el("summaryBadge").textContent = status;
            el("summaryBadge").className = "badge " + AMS.getDoctorStatusBadge(status);
 
            setAvatar(el("summaryAvatar"), initials);
            setAvatar(el("photoPreview"), initials);
        }
 
        ["fullName", "department", "specialty", "status", "room"].forEach(id => {
            el(id).addEventListener("input", refreshSummary);
            el(id).addEventListener("change", refreshSummary);
        });
 
        el("photo").addEventListener("change", () => {
            const file = el("photo").files[0];
            if (!file) return;
 
            if (photoUrl) URL.revokeObjectURL(photoUrl);
            photoUrl = URL.createObjectURL(file);
            refreshSummary();
        });
 
        /* ---------- Form ---------- */
        function gatherInput() {
            return {
                name: el("fullName").value.trim(),
                department: el("department").value,
                specialty: el("specialty").value.trim(),
                qualifications: el("qualifications").value.trim(),
                experienceYears: el("experience").value === "" ? null : Number(el("experience").value),
                languages: el("languages").value.trim(),
                room: el("room").value.trim(),
                status: el("status").value,
                phone: el("phone").value.trim(),
                email: el("email").value.trim(),
                bio: el("bio").value.trim()
            };
        }
 
        function setInvalid(id, invalid) {
            el(id).closest(".field").classList.toggle("invalid", Boolean(invalid));
        }
 
        el("doctorForm").addEventListener("submit", async e => {
            e.preventDefault();
 
            const input = gatherInput();
            const check = AMS.validateDoctorInput(input);
 
            setInvalid("fullName", check.errors.name);
            setInvalid("department", check.errors.department);
            setInvalid("specialty", check.errors.specialty);
            setInvalid("phone", check.errors.phone);
            setInvalid("email", check.errors.email);
 
            if (!check.valid) {
                const first = document.querySelector(".field.invalid");
                if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
                return;
            }
 
            const button = document.querySelector("#doctorForm button[type='submit']");
            button.disabled = true;
 
            const result = existing
                ? await AMS.updateDoctor(existing.id, input)
                : await AMS.createDoctor(input);
 
            if (!result.success) {
                button.disabled = false;
                AMS_UI.message("error", result.message);
                return;
            }
 
            // The photo is uploaded separately after the profile is saved
            const file = el("photo").files[0];
            let photoNote = "";
 
            if (file) {
                const upload = await AMS.uploadDoctorPhoto(result.doctor.id, file);
                if (!upload.success) photoNote = " The profile was saved, but the photo could not be uploaded: " + upload.message;
            }
 
            if (existing) {
                AMS_UI.message(photoNote ? "warning" : "success", "Doctor updated." + photoNote);
                setTimeout(() => { location.href = "Doctors.html"; }, photoNote ? 2500 : 900);
            } else {
                AMS_UI.message(photoNote ? "warning" : "success",
                    result.doctor.name + " was added. Next, set their consultation hours." + photoNote);
                setTimeout(() => {
                    location.href = "DoctorSchedule.html?id=" + encodeURIComponent(result.doctor.id);
                }, photoNote ? 2500 : 1200);
            }
        });
 
        /* ---------- Start ---------- */
        (async function init() {
            AMS_UI.initPage();
 
            try {
                await AMS.loadDepartments();
                if (editId) existing = await AMS.fetchDoctor(editId);
            } catch (error) {
                AMS_UI.showError(error);
 
                if (editId && !existing) {
                    document.querySelector("#doctorForm button[type='submit']").disabled = true;
                    return;
                }
            }
 
            el("department").innerHTML =
                '<option value="">Select department</option>' +
                AMS.getDepartments().map(d => "<option>" + esc(d.name) + "</option>").join("");
 
            if (existing) {
                el("pageTitle").textContent = "Edit doctor " + existing.id;
                el("pageSubtitle").textContent = "Update the profile, status and contact details.";
 
                el("doctorId").value = existing.id;
                el("fullName").value = existing.name || "";
                el("department").value = existing.department || "";
                el("specialty").value = existing.specialty || "";
                el("qualifications").value = existing.qualifications || "";
                el("experience").value = existing.experienceYears === null || existing.experienceYears === undefined ? "" : existing.experienceYears;
                el("languages").value = existing.languages || "";
                el("room").value = existing.room || "";
                el("status").value = existing.status || "Active";
                el("phone").value = existing.phone || "";
                el("email").value = existing.email || "";
                el("bio").value = existing.bio || "";
 
                savedPhotoUrl = AMS_UI.assetUrl(existing.photoUrl);
 
                el("summaryId").textContent = existing.id;
                el("summaryUpcoming").textContent = existing.upcomingAppointments || 0;
 
                el("summaryActions").innerHTML =
                    '<a href="DoctorSchedule.html?id=' + encodeURIComponent(existing.id) + '" class="action-button"><i class="fa-solid fa-clock"></i> Manage schedule</a>' +
                    '<a href="Appointments.html" class="action-button secondary"><i class="fa-solid fa-calendar-days"></i> View appointments</a>';
            }
 
            refreshSummary();
        })();


})();
