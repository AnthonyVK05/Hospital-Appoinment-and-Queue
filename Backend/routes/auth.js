/*
    routes/auth.js  ->  /api/auth

        POST /api/auth/login     { adminID, password }  -> { session: { token, staff } }
        GET  /api/auth/me        the staff member the token belongs to

    Passwords are checked with bcrypt. A password still stored as plain text
    in admin_account is accepted once and replaced by its bcrypt hash right
    away. Wrong ID and wrong password give the same answer and take the same
    time, and login attempts are limited per address.

    Needs:  npm install bcryptjs jsonwebtoken express-rate-limit
*/

const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const db = require("../config/database");
const pool = db.pool || db;

const { verifyToken, signToken } = require("../middleware/authMiddleware");

const BCRYPT_ROUNDS = 12;
const BCRYPT_FORMAT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

// Compared against when the ID does not exist, so an unknown ID costs the
// same time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,                        // failed attempts per address
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        code: "RATE_LIMITED",
        message: "Too many login attempts. Try again in 15 minutes."
    }
});

function sameText(a, b) {
    const left = crypto.createHash("sha256").update(a).digest();
    const right = crypto.createHash("sha256").update(b).digest();

    return crypto.timingSafeEqual(left, right);
}

router.post("/login", loginLimiter, async (req, res) => {
    try {
        const body = req.body || {};
        const adminId =
            typeof body.adminID === "string" ? body.adminID.trim() : "";
        const password =
            typeof body.password === "string" ? body.password : "";

        if (!adminId || !password || adminId.length > 50 || password.length > 200) {
            return res.status(400).json({
                success: false,
                message: "Enter your staff ID and password."
            });
        }

        const { rows } = await pool.query(
            "SELECT admin_id, password FROM admin_account WHERE admin_id = $1",
            [adminId]
        );

        const account = rows[0];
        let valid = false;

        if (!account) {
            await bcrypt.compare(password, DUMMY_HASH);
        } else if (BCRYPT_FORMAT.test(account.password)) {
            valid = await bcrypt.compare(password, account.password);
        } else {
            // Old plain-text password: accept it once, then store a hash.
            valid = sameText(password, account.password);

            if (valid) {
                try {
                    await pool.query(
                        "UPDATE admin_account SET password = $2 WHERE admin_id = $1",
                        [account.admin_id, await bcrypt.hash(password, BCRYPT_ROUNDS)]
                    );
                } catch (error) {
                    // Usually the password column is shorter than 60
                    // characters. See the note in the SQL block.
                    console.error(
                        "Could not store the password hash:", error.message
                    );
                }
            }
        }

        if (!valid) {
            return res.status(401).json({
                success: false,
                code: "INVALID_CREDENTIALS",
                message: "Invalid staff ID or password."
            });
        }

        const staff = { id: account.admin_id, role: "admin" };

        res.json({
            success: true,
            message: "Login successful!",
            session: {
                token: signToken(staff),
                staff: { staff_id: staff.id, role: staff.role }
            }
        });
    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message: "Could not log in. Please try again."
        });
    }
});

router.get("/me", verifyToken, (req, res) => {
    res.json({
        success: true,
        staff: { staff_id: req.user.staff_id, role: req.user.role }
    });
});

module.exports = router;