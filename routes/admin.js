const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const DoctorProfile = require("../models/DoctorProfile");
const mongoose = require("mongoose");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");

const router = express.Router();

const getClientIp = (req) => {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.ip;
};

const safeName = (value) => {
  const v = String(value || "").trim();
  return v || "—";
};

const logAdminAction = async (req, payload) => {
  try {
    await AuditLog.create({
      actorUser: req.user?.id || null,
      actorName: req.user?.phone || req.user?.id || "admin",
      action: payload.action,
      entityType: payload.entityType,
      entityId: payload.entityId || "",
      entityName: payload.entityName || "",
      details: payload.details || "",
      ip: getClientIp(req),
      timestamp: new Date(),
    });
  } catch (err) {
    console.warn("Audit log write failed:", err?.message);
  }
};

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

// Accept Iraqi phone formats: 07XXXXXXXXX or +9647XXXXXXXXX (after normalization)
const isValidIraqiPhone = (phone) => {
  const p = normalizePhone(phone);
  if (/^\+964\d{10}$/.test(p)) return true;
  if (/^07\d{9}$/.test(p)) return true;
  return false;
};

const ensureDoctorPrefix = (rawName = "") => {
  const name = String(rawName || "").trim();
  if (!name) return name;
  const prefixPattern = /^د\s*\.?\s*/i;
  const stripped = prefixPattern.test(name) ? name.replace(prefixPattern, "").trim() : name;
  return `د. ${stripped}`;
};

const isSubscriptionActive = (profile) => {
  if (!profile) return false;
  if (!profile.subscriptionEndsAt) return true;
  const cutoff = profile.subscriptionGraceEndsAt || profile.subscriptionEndsAt;
  const cutoffMs = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffMs)) return true;
  return Date.now() <= cutoffMs;
};

// Admin: list doctors (includes pending/inactive)
router.get(
  "/doctors",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { status } = req.query;
      const filter = {};
      if (status) filter.status = status;

      const doctors = await DoctorProfile.find(filter)
        .populate("user", "name email phone createdAt verificationCode loginCode")
        .sort({ createdAt: -1 });

      return res.json({ doctors });
    } catch (err) {
      console.error("Admin doctors list error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: get full doctor details (profile + user + bookings)
router.get(
  "/doctors/:id",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid doctor id" });
      }

      const doctor = await DoctorProfile.findById(id).populate(
        "user",
        "name email phone createdAt verificationCode loginCode role"
      );
      if (!doctor) return res.status(404).json({ message: "Doctor not found" });

      const Appointment = require("../models/Appointment");

      const appointments = await Appointment.find({ doctorProfile: doctor._id })
        .populate("user", "name phone email")
        .sort({ createdAt: -1 })
        .limit(500);

      const totalAppointments = await Appointment.countDocuments({ doctorProfile: doctor._id });
      const statusCountsAgg = await Appointment.aggregate([
        { $match: { doctorProfile: doctor._id } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      const appointmentStatusCounts = statusCountsAgg.reduce((acc, row) => {
        acc[row._id || "unknown"] = row.count;
        return acc;
      }, {});

      return res.json({
        doctor,
        meta: {
          totalAppointments,
          appointmentStatusCounts,
        },
        appointments,
      });
    } catch (err) {
      console.error("Admin doctor details error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: update doctor basic profile info (profile + linked user)
router.patch(
  "/doctors/:id/profile",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid doctor id" });
      }

      const doctor = await DoctorProfile.findById(id).populate("user", "name email phone role");
      if (!doctor) return res.status(404).json({ message: "Doctor not found" });

      const user = doctor.user;
      if (!user || !user._id) return res.status(500).json({ message: "Linked user not found" });

      // DoctorProfile fields
      if (typeof req.body.displayName === "string") {
        const v = req.body.displayName.trim();
        if (v) doctor.displayName = ensureDoctorPrefix(v);
      }
      if (typeof req.body.location === "string") doctor.location = req.body.location.trim();
      if (typeof req.body.licenseNumber === "string") doctor.licenseNumber = req.body.licenseNumber.trim();
      if (typeof req.body.secretaryPhone === "string") doctor.secretaryPhone = req.body.secretaryPhone.trim();
      if (typeof req.body.avatarUrl === "string") doctor.avatarUrl = req.body.avatarUrl.trim();
      if (typeof req.body.consultationFee !== "undefined") {
        const fee = Number(req.body.consultationFee);
        if (!Number.isFinite(fee) || fee < 0) {
          return res.status(400).json({ message: "consultationFee must be a non-negative number" });
        }
        doctor.consultationFee = fee;
      }

      // User fields
      if (typeof req.body.name === "string") {
        const v = req.body.name.trim();
        if (v) user.name = v;
      }
      if (typeof req.body.email !== "undefined") {
        const cleanEmail = req.body.email ? String(req.body.email).toLowerCase().trim() : undefined;
        user.email = cleanEmail || undefined;
      }
      if (typeof req.body.phone === "string") {
        if (!isValidIraqiPhone(req.body.phone)) {
          return res.status(400).json({ message: "صيغة رقم الجوال غير صحيحة" });
        }
        const normalizedPhone = normalizePhone(req.body.phone);
        const dup = await User.findOne({ phone: normalizedPhone, _id: { $ne: user._id } });
        if (dup) {
          return res.status(409).json({ message: "رقم الجوال مستخدم من حساب آخر" });
        }
        user.phone = normalizedPhone;
      }

      await user.save();
      await doctor.save();

      await logAdminAction(req, {
        action: "EDIT",
        entityType: "Doctor",
        entityId: String(doctor._id),
        entityName: safeName(doctor.displayName || user.name),
        details: "Updated doctor profile",
      });

      return res.json({ message: "Updated" });
    } catch (err) {
      console.error("Admin update doctor profile error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: update doctor status (activate/deactivate/pend)
router.patch(
  "/doctors/:id/status",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body || {};

      const allowed = new Set(["pending", "active", "inactive"]);
      if (!allowed.has(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      const doctor = await DoctorProfile.findById(id);
      if (!doctor) return res.status(404).json({ message: "Doctor not found" });

      doctor.status = status;
      if (status === "active") {
        // When admin approves, allow bookings by default.
        doctor.isAcceptingBookings = true;
      }
      if (status === "inactive") {
        doctor.isAcceptingBookings = false;
      }
      await doctor.save();

      await logAdminAction(req, {
        action: status === "inactive" ? "BLOCK" : status === "active" ? "UNBLOCK" : "EDIT",
        entityType: "Doctor",
        entityId: String(doctor._id),
        entityName: safeName(doctor.displayName),
        details: `Status -> ${status}`,
      });

      return res.json({ message: "Status updated", doctor });
    } catch (err) {
      console.error("Admin doctor status update error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: update doctor booking availability
router.patch(
  "/doctors/:id/booking",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isAcceptingBookings } = req.body || {};

      if (typeof isAcceptingBookings !== "boolean") {
        return res.status(400).json({ message: "isAcceptingBookings must be boolean" });
      }

      const doctor = await DoctorProfile.findById(id);
      if (!doctor) return res.status(404).json({ message: "Doctor not found" });

      doctor.isAcceptingBookings = isAcceptingBookings;
      await doctor.save();

      await logAdminAction(req, {
        action: "EDIT",
        entityType: "Doctor",
        entityId: String(doctor._id),
        entityName: safeName(doctor.displayName),
        details: `Booking availability -> ${isAcceptingBookings}`,
      });

      return res.json({ message: "Booking availability updated", doctor });
    } catch (err) {
      console.error("Admin doctor booking update error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: update doctor chat availability
router.patch(
  "/doctors/:id/chat",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isChatEnabled } = req.body || {};

      if (typeof isChatEnabled !== "boolean") {
        return res.status(400).json({ message: "isChatEnabled must be boolean" });
      }

      const doctor = await DoctorProfile.findById(id);
      if (!doctor) return res.status(404).json({ message: "Doctor not found" });

      doctor.isChatEnabled = isChatEnabled;
      await doctor.save();

      await logAdminAction(req, {
        action: "EDIT",
        entityType: "Doctor",
        entityId: String(doctor._id),
        entityName: safeName(doctor.displayName),
        details: `Chat enabled -> ${isChatEnabled}`,
      });

      return res.json({ message: "Chat availability updated", doctor });
    } catch (err) {
      console.error("Admin doctor chat update error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Update doctor's subscription (admin only)
router.patch(
  "/doctors/:id/subscription",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        subscriptionPlan,
        subscriptionStartsAt,
        subscriptionEndsAt,
        subscriptionGraceEndsAt,
        extendMonths,
        setInactive,
        setActive,
      } = req.body;
      const doc = await DoctorProfile.findById(id);
      if (!doc) return res.status(404).json({ message: "Doctor not found" });

      if (subscriptionPlan !== undefined)
        doc.subscriptionPlan = subscriptionPlan;
      if (subscriptionStartsAt !== undefined)
        doc.subscriptionStartsAt = subscriptionStartsAt
          ? new Date(subscriptionStartsAt)
          : null;
      if (subscriptionEndsAt !== undefined)
        doc.subscriptionEndsAt = subscriptionEndsAt
          ? new Date(subscriptionEndsAt)
          : null;
      if (subscriptionGraceEndsAt !== undefined)
        doc.subscriptionGraceEndsAt = subscriptionGraceEndsAt
          ? new Date(subscriptionGraceEndsAt)
          : null;

      // Convenience: extend by N months from max(now, currentEndsAt)
      if (extendMonths !== undefined) {
        const m = Number(extendMonths);
        if (!Number.isFinite(m) || m <= 0 || m > 120) {
          return res.status(400).json({ message: "extendMonths must be 1..120" });
        }
        const now = new Date();
        const base = doc.subscriptionEndsAt && doc.subscriptionEndsAt > now ? doc.subscriptionEndsAt : now;
        const next = new Date(base);
        next.setMonth(next.getMonth() + Math.floor(m));
        if (!doc.subscriptionStartsAt) doc.subscriptionStartsAt = now;
        doc.subscriptionEndsAt = next;
      }

      // Manual controls
      if (setInactive === true) {
        doc.status = "inactive";
        doc.isAcceptingBookings = false;
        // make subscription effectively inactive
        const now = new Date();
        doc.subscriptionGraceEndsAt = null;
        doc.subscriptionEndsAt = new Date(now.getTime() - 1000);
      }
      if (setActive === true) {
        doc.status = "active";
      }

      doc.subscriptionUpdatedAt = new Date();
      doc.subscriptionUpdatedBy = req.user?.id || null;

      // If subscription is inactive/expired, disable the doctor from all services.
      if (!isSubscriptionActive(doc)) {
        doc.status = "inactive";
        doc.isAcceptingBookings = false;
      }

      await doc.save();

      await logAdminAction(req, {
        action: extendMonths !== undefined ? "EXTEND" : (setInactive === true || setActive === true || subscriptionEndsAt !== undefined || subscriptionStartsAt !== undefined) ? "RENEW" : "EDIT",
        entityType: "Subscription",
        entityId: String(doc._id),
        entityName: safeName(doc.displayName),
        details: "Subscription updated",
      });
      return res.json({ message: "Subscription updated", doctor: doc });
    } catch (err) {
      console.error("Admin subscription update error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: list patients
router.get(
  "/patients",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const User = require("../models/User");
      const patients = await User.find({ role: "patient" })
        .select("name phone email createdAt isBlocked blockedAt blockedReason")
        .sort({ createdAt: -1 });
      return res.json({ patients });
    } catch (err) {
      console.error("Admin patients error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: block/unblock patient
router.patch(
  "/patients/:id/block",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid patient id" });
      }

      const { blocked, reason } = req.body || {};
      if (typeof blocked !== "boolean") {
        return res.status(400).json({ message: "blocked must be boolean" });
      }

      const patient = await User.findById(id).select("role name phone isBlocked blockedAt blockedReason");
      if (!patient) return res.status(404).json({ message: "Patient not found" });
      if (patient.role !== "patient") {
        return res.status(400).json({ message: "Target user is not a patient" });
      }

      patient.isBlocked = blocked;
      patient.blockedAt = blocked ? new Date() : null;
      patient.blockedReason = blocked ? String(reason || "").trim() : "";
      await patient.save();

      await logAdminAction(req, {
        action: blocked ? "BLOCK" : "UNBLOCK",
        entityType: "Patient",
        entityId: String(patient._id),
        entityName: safeName(patient.name),
        details: blocked ? (patient.blockedReason ? `Blocked: ${patient.blockedReason}` : "Blocked") : "Unblocked",
      });

      return res.json({ message: "Updated", patient });
    } catch (err) {
      console.error("Admin patient block error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: list appointments
router.get(
  "/appointments",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const Appointment = require("../models/Appointment");
      const appointments = await Appointment.find({})
        .populate("doctorProfile", "displayName specialtyLabel")
        .populate("user", "name phone email")
        .sort({ createdAt: -1 })
        .limit(1000);
      return res.json({ appointments });
    } catch (err) {
      console.error("Admin appointments error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: cancel appointment
router.patch(
  "/appointments/:id/cancel",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const Appointment = require("../models/Appointment");
      const appointment = await Appointment.findById(req.params.id);
      if (!appointment) {
        return res.status(404).json({ message: "Appointment not found" });
      }

      appointment.status = "cancelled";
      // invalidate old QR codes (booking numbers are monotonic and not reused)
      appointment.qrCode = "";
      appointment.qrPayload = "";
      await appointment.save();

      const populated = await Appointment.findById(appointment._id)
        .populate("doctorProfile", "displayName specialtyLabel")
        .populate("user", "name phone email");

      await logAdminAction(req, {
        action: "EDIT",
        entityType: "Appointment",
        entityId: String(populated?._id || appointment._id),
        entityName: safeName(populated?._id),
        details: "Appointment cancelled",
      });

      return res.json({ appointment: populated });
    } catch (err) {
      console.error("Admin cancel appointment error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: complete appointment
router.patch(
  "/appointments/:id/complete",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const Appointment = require("../models/Appointment");
      const appointment = await Appointment.findById(req.params.id);
      if (!appointment) {
        return res.status(404).json({ message: "Appointment not found" });
      }

      appointment.status = "completed";
      await appointment.save();

      const populated = await Appointment.findById(appointment._id)
        .populate("doctorProfile", "displayName specialtyLabel")
        .populate("user", "name phone email");

      await logAdminAction(req, {
        action: "EDIT",
        entityType: "Appointment",
        entityId: String(populated?._id || appointment._id),
        entityName: safeName(populated?._id),
        details: "Appointment completed",
      });

      return res.json({ appointment: populated });
    } catch (err) {
      console.error("Admin complete appointment error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

// Admin: audit logs
router.get(
  "/audit-logs",
  authMiddleware,
  authMiddleware.requireRole("admin"),
  async (req, res) => {
    try {
      const { action, entityType, search } = req.query;
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 500)));
      const skip = Math.max(0, Number(req.query.skip || 0));

      const filter = {};
      if (action) filter.action = String(action);
      if (entityType) filter.entityType = String(entityType);
      if (search) {
        const rx = new RegExp(String(search), "i");
        filter.$or = [{ actorName: rx }, { entityName: rx }, { details: rx }];
      }

      const logs = await AuditLog.find(filter)
        .sort({ timestamp: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      return res.json({ logs });
    } catch (err) {
      console.error("Admin audit logs error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router;
