const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const DoctorProfile = require("../models/DoctorProfile");

const router = express.Router();

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

module.exports = router;

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
