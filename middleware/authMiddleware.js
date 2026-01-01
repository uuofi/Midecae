// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const DoctorProfile = require("../models/DoctorProfile");

const normalizePhone = (phone) => {
  let p = String(phone || "").replace(/\s|-/g, "").trim();
  // +964 + 10 digits
  if (/^\+964\d{10}$/.test(p)) return p;
  // 0 + 10 digits
  if (/^0\d{10}$/.test(p)) return "+964" + p.slice(1);
  // 10 digits only
  if (/^\d{10}$/.test(p)) return "+964" + p;
  return p;
};

const isSubscriptionActive = (profile) => {
  if (!profile) return false;
  // No end date means: no active subscription.
  if (!profile.subscriptionEndsAt) return false;
  const cutoff = profile.subscriptionGraceEndsAt || profile.subscriptionEndsAt;
  const cutoffMs = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffMs)) return false;
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
    const userDoc = await User.findById(decoded.id).select("role phone isBlocked");
    if (!userDoc) {
      return res.status(401).json({ message: "User not found" });
    }

    // Patient global block
    if (userDoc.role === "patient" && userDoc.isBlocked) {
      return res.status(403).json({ message: "Account is blocked" });
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
        "status isAcceptingBookings isChatEnabled subscriptionEndsAt subscriptionGraceEndsAt"
      );
      if (!profile) {
        return res.status(403).json({ message: "Doctor profile not found" });
      }
      if (profile.status !== "active") {
        return res.status(403).json({ message: "Doctor account is inactive" });
      }
      if (!isSubscriptionActive(profile)) {
        // Hard stop: subscription ended => fully disable account services.
        try {
          profile.status = "inactive";
          profile.isAcceptingBookings = false;
          profile.isChatEnabled = false;
          await profile.save();
        } catch (e) {}
        return res.status(403).json({ message: "الاشتراك منتهي وتم إيقاف الحساب" });
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

    // Optional hard lock: only the configured admin phone can act as admin.
    if (role === "admin" && process.env.ADMIN_PHONE) {
      const expected = normalizePhone(process.env.ADMIN_PHONE);
      const actual = normalizePhone(req.user.phone);
      if (expected && actual && expected !== actual) {
        return res.status(403).json({ message: "Forbidden: admin access is restricted" });
      }
    }

    return next();
  };
};

module.exports = authMiddleware;
