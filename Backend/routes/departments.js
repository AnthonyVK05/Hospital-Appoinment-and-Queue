/*
    routes/departments.js  ->  GET /api/departments

    The departments table is shared by the whole group, so this route
    is read-only. ams.js calls /departments (plural), so keep this file
    name as departments.js.
*/

const express = require("express");

const router = express.Router();

const db = require("../config/database");
const pool = db.pool || db;

router.get("/", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id,
                   department_code AS code,
                   department_name AS name
            FROM departments
            WHERE is_active
            ORDER BY department_name
        `);

        res.json({ success: true, departments: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Could not load departments."
        });
    }
});

module.exports = router;