const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const DoctorProfile = require("../models/DoctorProfile");
const mongoose = require("mongoose");

const router = express.Router();

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

      return res.json({ message: "Booking availability updated", doctor });
    } catch (err) {
      console.error("Admin doctor booking update error:", err?.message);
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
        .select("name phone email createdAt")
        .sort({ createdAt: -1 });
      return res.json({ patients });
    } catch (err) {
      console.error("Admin patients error:", err?.message);
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

      return res.json({ appointment: populated });
    } catch (err) {
      console.error("Admin complete appointment error:", err?.message);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router;
