document.addEventListener("DOMContentLoaded", function () {

    // Page shown after a successful admin login.
    // Change this if your dashboard file has a different name.
    const HOME_PAGE = window.AMS_HOME_PAGE || "HospitalAnalytics.html";

    // Only administrators may use this system
    const ALLOWED_ROLE = "admin";

    const form = document.getElementById("loginForm");
    const errorLabel = document.getElementById("loginError");
    const loginButton = form.querySelector(".login-button");

    // Already logged in: go straight to the dashboard.
    // If the saved token has expired, the dashboard's first request
    // returns 401, clears the session and sends the user back here.
    if (AMS.isLoggedIn()) {
        window.location.replace(HOME_PAGE);
        return;
    }

    // Remove the error message as soon as the user edits a field
    form.addEventListener("input", function () {
        errorLabel.textContent = "";
    });

    form.addEventListener("submit", async function (e) {

        e.preventDefault();

        // Clear the previous error message
        errorLabel.textContent = "";

        // Get the Admin ID and password
        const adminID = document.getElementById("adminID").value.trim();
        const password = document.getElementById("password").value;

        // Prevent empty input
        if (!adminID || !password) {
            errorLabel.textContent = "Please enter your Admin ID and password.";
            return;
        }

        let redirecting = false;

        try {

            // Disable the button while processing login
            loginButton.disabled = true;
            loginButton.textContent = "Logging in...";

            // Send login details to the backend API through ams.js.
            // On success it saves the token (amsToken) and the staff ID
            // (staffID) in sessionStorage, which the AMS pages read.
            const result = await AMS.login(adminID, password);

            if (!result.success) {
                throw new Error(result.message);
            }

            // Admin accounts only. The server must enforce this too,
            // because this check can be bypassed in the browser.
            const staff = result.session && result.session.staff;
            const role = staff && staff.role
                ? String(staff.role).toLowerCase()
                : "";

            if (role && role !== ALLOWED_ROLE) {
                AMS.logout();
                throw new Error("This system is for administrators only.");
            }

            // Redirect to the dashboard
            redirecting = true;
            window.location.href = HOME_PAGE;

        } catch (err) {

            // Display the login error
            errorLabel.textContent =
                err.message || "Login failed. Please check your Admin ID and password.";

        } finally {

            // Restore the login button (unless the page is moving on)
            if (!redirecting) {
                loginButton.disabled = false;
                loginButton.textContent = "Login";
            }

        }

    });

});