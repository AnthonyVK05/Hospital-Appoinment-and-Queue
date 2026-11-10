const express = require('express');
const router = express.Router();

const db = require('../config/database');
const pool = db.pool || db;

// Admin Login
router.post('/login', async (req, res) => {
    try {
        const { adminID, password } = req.body;

        // Check empty input
        if (!adminID || !password) {
            return res.status(400).json({
                success: false,
                message: 'Please enter Admin ID and password.'
            });
        }

        // Find admin account
        const result = await pool.query(
            `SELECT admin_id, password
             FROM admin_account
             WHERE admin_id = $1`,
            [adminID]
        );

        // Check Admin ID
        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid Admin ID or password.'
            });
        }

        const admin = result.rows[0];

        // Check password
        if (admin.password !== password) {
            return res.status(401).json({
                success: false,
                message: 'Invalid Admin ID or password.'
            });
        }

        // Login successful
        return res.status(200).json({
            success: true,
            message: 'Login successful!',
            session: {
                staff: {
                    staff_id: admin.admin_id,
                    role: 'admin'
                }
            }
        });

    } catch (error) {
        console.error('Login error:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error during login.'
        });
    }
});

module.exports = router;