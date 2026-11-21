/*
    middleware/authMiddleware.js   (backend/middleware/, NOT inside routes/)

    JWT protection for the API, with the same names as before:

        verifyToken        checks "Authorization: Bearer <token>", then checks
                           that the admin account still exists
        requireRole(...)   allows only the listed roles (403 otherwise)
        signToken(admin)   issues the token at login (used by routes/auth.js)

    Tokens are issued by AMS login for rows of admin_account, so that is the
    table checked on every request. Removing an admin from admin_account
    therefore ends their access at once, without waiting for the token to
    expire. (The previous version looked the account up in users by a numeric
    id. AMS tokens have no such id, so every token would have been refused.)

    Settings in backend/.env:
        JWT_SECRET      at least 32 random characters; the server refuses to
                        start without it. Generate one with:
                        node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
        JWT_EXPIRES_IN  optional, default 1h
*/

const jwt = require("jsonwebtoken");

const db = require("../config/database");
const pool = db.pool || db;

const SECRET = process.env.JWT_SECRET;

if (!SECRET || SECRET.length < 32) {
    throw new Error(
        "JWT_SECRET is missing or too short. Add a random value of at " +
        "least 32 characters to backend/.env"
    );
}

const ALGORITHM = "HS256";
const ISSUER = "hospital-analytics-api";
const AUDIENCE = "ams-web";
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";

// admin = { id: "ST-0001", role: "admin" }
function signToken(admin) {
    return jwt.sign(
        { role: admin.role },
        SECRET,
        {
            algorithm: ALGORITHM,
            subject: String(admin.id),
            issuer: ISSUER,
            audience: AUDIENCE,
            expiresIn: EXPIRES_IN
        }
    );
}

function deny(res, status, code, message) {
    return res.status(status).json({
        success: false,
        code,
        message
    });
}

// ==========================================
// VERIFY JWT TOKEN
// ==========================================

const verifyToken = async (req, res, next) => {
    try {
        const header = req.headers.authorization || "";
        const match = /^Bearer\s+(\S+)$/i.exec(header);

        if (!match) {
            return deny(
                res, 401, "UNAUTHORIZED",
                "Access denied. Please log in."
            );
        }

        // The accepted algorithm is fixed, so a token signed with "none"
        // or another algorithm is refused.
        const decoded = jwt.verify(match[1], SECRET, {
            algorithms: [ALGORITHM],
            issuer: ISSUER,
            audience: AUDIENCE
        });

        // The account must still exist.
        const result = await pool.query(
            "SELECT admin_id FROM admin_account WHERE admin_id = $1",
            [decoded.sub]
        );

        if (result.rows.length === 0) {
            return deny(
                res, 401, "ACCOUNT_NOT_FOUND",
                "Staff account not found. Please log in again."
            );
        }

        req.user = {
            id: result.rows[0].admin_id,
            staff_id: result.rows[0].admin_id,
            role: decoded.role
        };

        next();
    } catch (error) {
        if (error.name === "TokenExpiredError") {
            return deny(
                res, 401, "TOKEN_EXPIRED",
                "Your session has expired. Please log in again."
            );
        }

        if (
            error.name === "JsonWebTokenError" ||
            error.name === "NotBeforeError"
        ) {
            return deny(
                res, 401, "INVALID_TOKEN",
                "Invalid authentication token."
            );
        }

        console.error("Authentication error:", error);

        return deny(
            res, 500, "AUTH_ERROR",
            "Authentication server error."
        );
    }
};

// ==========================================
// CHECK USER ROLE   (use after verifyToken)
// router.delete("/:id", requireRole("admin"), ...)
// ==========================================

const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return deny(
                res, 401, "UNAUTHORIZED",
                "Authentication required."
            );
        }

        const userRole = String(req.user.role).toLowerCase();
        const roles = allowedRoles.map(role => String(role).toLowerCase());

        if (!roles.includes(userRole)) {
            return deny(
                res, 403, "FORBIDDEN",
                "You do not have permission to access this resource."
            );
        }

        next();
    };
};

module.exports = { verifyToken, requireRole, signToken };