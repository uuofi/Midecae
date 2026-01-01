const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const DoctorProfile = require("../models/DoctorProfile");

const router = express.Router();

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
        .populate("user", "name email phone")
        .sort({ createdAt: -1 });

      return res.json({ doctors });
    } catch (err) {
      console.error("Admin doctors list error:", err?.message);
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
      doc.subscriptionUpdatedAt = new Date();
      doc.subscriptionUpdatedBy = req.user?.id || null;

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

module.exports = router;
