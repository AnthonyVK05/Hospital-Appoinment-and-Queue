require('dotenv').config();
 
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
 
// config/database.js should export the pg Pool: module.exports = pool;
// ({ pool } is accepted too.)
const db = require('./config/database');
const pool = db.pool || db;

// JWT protection (middleware/authMiddleware.js)
const { verifyToken } = require('./middleware/authMiddleware');
 
const app = express();
const PORT = process.env.PORT || 3000;
// Frontend files are stored in the parent directory
const frontendPath = path.join(__dirname, '..');

// Security headers (X-Content-Type-Options, X-Frame-Options, ...)
app.use(helmet());

// Doctor photos (routes/doctors.js saves them in backend/uploads/doctors).
// They are shown in <img> and CSS backgrounds, which cannot send a token,
// so this folder is public; only images are ever written to it. The
// cross-origin header lets pages on Live Server (another port) show them.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    index: false,
    dotfiles: 'deny',
    setHeaders: res => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
}));


 
/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */
 
// Parse JSON request bodies
app.use(express.json({ limit: '1mb' }));


// Minimal CORS so pages served by VS Code Live Server (port 5500) can call this API.
// Add more origins in .env: CORS_ORIGIN=http://127.0.0.1:5500,http://localhost:5500
const allowedOrigins = (process.env.CORS_ORIGIN ||
    'http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:5501,http://localhost:5501')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
 
app.use((req, res, next) => {
    const origin = req.headers.origin;
 
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
 
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});
 
/* ------------------------------------------------------------------ */
/* Authentication: every /api request needs a valid token              */
/* ------------------------------------------------------------------ */

// Only these may be called without a token. This must stay AFTER the CORS
// block above: the browser's OPTIONS preflight carries no token.
const PUBLIC_API = ['GET /health', 'POST /auth/login'];

app.use('/api', (req, res, next) => {
    if (PUBLIC_API.includes(req.method + ' ' + req.path)) return next();
    verifyToken(req, res, next);
});

/* ------------------------------------------------------------------ */
/* Test routes                                                         */
/* ------------------------------------------------------------------ */
 
// Step 6: open http://localhost:3000/api/health to check the database connection
app.get('/api/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() AS server_time');
        res.json({
            status: 'ok',
            database: 'connected',
            serverTime: result.rows[0].server_time
        });
    } catch (err) {
        // Log the detail on the server only. Do not send connection details to the browser.
        console.error('Health check failed:', err.message);
        res.status(503).json({ status: 'error', database: 'unreachable' });
    }
});
 
/* ------------------------------------------------------------------ */
/* Module routes                                                       */
/* ------------------------------------------------------------------ */

// Every file in backend/routes is mounted automatically:
//   routes/appointments.js  ->  /api/appointments
//   routes/doctors.js       ->  /api/doctors
// Each file must export an express.Router(). Helper code goes in
// backend/lib or backend/middleware, never in routes/.

const routesDir = path.join(__dirname, 'routes');

if (fs.existsSync(routesDir)) {

    const routeFiles = fs.readdirSync(routesDir)
        .filter(file => file.endsWith('.js'));

    console.log("\n========== LOADING API ROUTES ==========");

    routeFiles.forEach(file => {

        const name = path.basename(file, '.js');

        try {

            const route = require(path.join(routesDir, file));

            if (typeof route !== 'function') {
                throw new Error(
                    `${file} does not export an Express Router.`
                );
            }

            app.use('/api/' + name, route);

            console.log(`SUCCESS: /api/${name}`);

        } catch (error) {

            console.error(`FAILED: ${file}`);
            console.error(error.stack);

        }

    });

    console.log("========== ROUTE LOADING COMPLETE ==========\n");

} else {

    console.error("Routes folder not found:", routesDir);

}

/* ------------------------------------------------------------------ */
/* Frontend Hosting                                                    */
/* ------------------------------------------------------------------ */

// Prevent public access to backend source files
app.use((req, res, next) => {
    if (/^\/backend(?:\/|$)/i.test(req.path)) {
        return res.sendStatus(404);
    }

    next();
});

// Serve frontend HTML, CSS, JavaScript and images
app.use(express.static(frontendPath, {
    index: false,
    dotfiles: 'deny'
}));

// Main website homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'login.html'));
});

console.log('Frontend directory:', frontendPath);
 
/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
 
// Unknown API path
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});
 
// Anything thrown or passed to next(err) in a route
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});
 
/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
 
const server = app.listen(PORT, async () => {
    console.log('Server running on http://localhost:' + PORT);
 
    // Check the database once at startup so problems show up straight away
    try {
        await pool.query('SELECT 1');
        console.log('PostgreSQL (Neon) connection OK');
    } catch (err) {
        console.error('PostgreSQL connection FAILED:', err.message);
        console.error('Check backend/.env and that your IP/network can reach Neon.');
    }
});

 
// Close the server and the connection pool cleanly (Ctrl+C in the terminal)
function shutdown(signal) {
    console.log(signal + ' received, shutting down...');
    server.close(async () => {
        await pool.end();
        process.exit(0);
    });
}
 
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
