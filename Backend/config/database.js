const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,

    ssl: process.env.DB_SSL === "true"
        ? { rejectUnauthorized: false }
        : false,

    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
});

pool.on("connect", () => {
    console.log("PostgreSQL connected");
});

pool.on("error", (err) => {
    console.error("PostgreSQL error:", err);
});

module.exports = pool;