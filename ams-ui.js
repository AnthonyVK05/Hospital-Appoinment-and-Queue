/*
 * ams-ui.js - small UI helpers shared by the AMS pages.
 * Load it after ams.js:
 *   <script src="ams.js"></script>
 *   <script src="ams-ui.js"></script>
 */
const AMS_UI = (() => {
    "use strict";

    // Escape text before putting API data into innerHTML.
    function esc(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/[&<>"']/g, character => ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                "\"": "&quot;",
                "'": "&#39;"
            }[character]));
    }

    // Banner shown under the page title: success, warning or error.
    function getBanner() {
        let box = document.getElementById("pageMessage");

        if (!box) {
            box = document.createElement("div");
            box.id = "pageMessage";
            box.className = "message-box";
            box.style.marginBottom = "18px";

            const header = document.querySelector(".page-header");

            if (header && header.parentNode) {
                header.parentNode.insertBefore(
                    box,
                    header.nextSibling
                );
            } else {
                document.body.prepend(box);
            }
        }

        return box;
    }

    // text is plain text and is escaped. Use messageHtml for markup.
    function message(type, text) {
        messageHtml(type, esc(text));
    }

    function messageHtml(type, html) {
        const box = getBanner();

        box.className = "message-box show " + type;
        box.innerHTML = html;
        box.scrollIntoView({ block: "nearest" });
    }

    function clearMessage() {
        getBanner().className = "message-box";
    }

    function showError(error) {
        message("error", AMS.getErrorMessage(error));
    }

    // Image paths such as /uploads/doctor.jpg come from the API server.
    function assetUrl(path) {
        if (!path) return "";

        if (/^(https?:|data:|blob:)/i.test(path)) {
            return path;
        }

        try {
            return new URL(AMS.API_BASE).origin + path;
        } catch (error) {
            return path;
        }
    }

    // Shows the logged-in staff ID and wires the Logout button.
    function initPage() {
        const session = AMS.getSession();
        const staff = document.querySelector(".staff-id");

        if (staff && session.staffID && staff.firstChild) {
            staff.firstChild.textContent =
                "Staff ID: " + session.staffID + " ";
        }

        const logout = document.querySelector(".logout-button");

        if (logout) {
            logout.addEventListener("click", () => {
                AMS.logout();
                window.location.href =
                    window.AMS_LOGIN_PAGE || "Login.html";
            });
        }
    }

    return {
        esc,
        message,
        messageHtml,
        clearMessage,
        showError,
        assetUrl,
        initPage
    };
})();