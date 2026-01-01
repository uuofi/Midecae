// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const DoctorProfile = require("../models/DoctorProfile");

const isSubscriptionActive = (profile) => {
  if (!profile) return false;
  // If no end date, treat as active (free/indefinite).
  if (!profile.subscriptionEndsAt) return true;
  const cutoff = profile.subscriptionGraceEndsAt || profile.subscriptionEndsAt;
  const cutoffMs = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffMs)) return true;
  return Date.now() <= cutoffMs;
};

// Default auth middleware usable as before
const authMiddleware = async function (req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Always re-load user from DB so role changes apply immediately.
    const userDoc = await User.findById(decoded.id).select("role phone");
    if (!userDoc) {
      return res.status(401).json({ message: "User not found" });
    }

    // نخزن بيانات اليوزر من التوكن + تحديث الدور من DB
    req.user = {
      ...decoded,
      id: String(userDoc._id),
      role: userDoc.role,
      phone: userDoc.phone,
    };

    // If doctor: enforce active status + subscription validity for ALL protected APIs.
    if (userDoc.role === "doctor") {
      const profile = await DoctorProfile.findOne({ user: userDoc._id }).select(
        "status subscriptionEndsAt subscriptionGraceEndsAt"
      );
      if (!profile) {
        return res.status(403).json({ message: "Doctor profile not found" });
      }
      if (profile.status !== "active") {
        return res.status(403).json({ message: "Doctor account is inactive" });
      }
      if (!isSubscriptionActive(profile)) {
        return res.status(403).json({ message: "Subscription expired" });
      }
      req.doctorProfileId = String(profile._id);
    }

    return next();
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
