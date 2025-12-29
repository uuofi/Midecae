// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");

// Default auth middleware usable as before
const authMiddleware = function (req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // نخزن بيانات اليوزر من التوكن
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    return res.status(401).json({ message: "Token is not valid" });
  }
};

// Role guard factory: requireRole('admin')
authMiddleware.requireRole = function (role) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ message: "No token, authorization denied" });
    if (!role) return next();
    if (req.user.role !== role) return res.status(403).json({ message: "Forbidden: insufficient role" });
    return next();
  };
};

module.exports = authMiddleware;
