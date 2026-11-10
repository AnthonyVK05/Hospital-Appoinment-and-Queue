const jwt = require("jsonwebtoken");

const pool = require("../config/database");


// ==========================================
// VERIFY JWT TOKEN
// ==========================================

const verifyToken = async (req, res, next) => {

    try {

        // Get authorization header
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {

            return res.status(401).json({

                success: false,
                message: "Access denied. Please log in."

            });

        }

        // Extract token
        const token = authHeader.split(" ")[1];

        // Verify JWT token
        const decoded = jwt.verify(

            token,
            process.env.JWT_SECRET,

            {
                issuer: "hospital-analytics-api"
            }

        );

        // Check whether account still exists and is active
        const result = await pool.query(

            `SELECT
                id,
                staff_id,
                full_name,
                role,
                is_active
             FROM users
             WHERE id = $1`,
            [decoded.id]

        );

        if (result.rows.length === 0) {

            return res.status(401).json({

                success: false,
                message: "Staff account not found."

            });

        }

        const staff = result.rows[0];

        // Check account status
        if (!staff.is_active) {

            return res.status(403).json({

                success: false,
                message: "Your account has been deactivated."

            });

        }

        // Attach staff information to request
        req.user = {

            id: staff.id,
            staff_id: staff.staff_id,
            full_name: staff.full_name,
            role: staff.role

        };

        next();

    } catch (error) {

        if (error.name === "TokenExpiredError") {

            return res.status(401).json({

                success: false,
                message: "Your session has expired. Please log in again."

            });

        }

        if (error.name === "JsonWebTokenError") {

            return res.status(401).json({

                success: false,
                message: "Invalid authentication token."

            });

        }

        console.error("Authentication error:", error);

        return res.status(500).json({

            success: false,
            message: "Authentication server error."

        });

    }

};


// ==========================================
// CHECK USER ROLE
// ==========================================

const requireRole = (...allowedRoles) => {

    return (req, res, next) => {

        if (!req.user) {

            return res.status(401).json({

                success: false,
                message: "Authentication required."

            });

        }

        const userRole = String(req.user.role).toLowerCase();

        const roles = allowedRoles.map(role =>
            String(role).toLowerCase()
        );

        if (!roles.includes(userRole)) {

            return res.status(403).json({

                success: false,
                message: "You do not have permission to access this resource."

            });

        }

        next();

    };

};


module.exports = {

    verifyToken,
    requireRole

};