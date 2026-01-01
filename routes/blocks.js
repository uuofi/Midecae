const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const User = require("../models/User");
const DoctorProfile = require("../models/DoctorProfile");
const Block = require("../models/Block");

const router = express.Router();

// Doctor sets or updates block for a patient
router.post("/", authMiddleware, authMiddleware.requireRole("doctor"), async (req, res) => {
  try {
    const { patientId, blockChat, blockBooking } = req.body || {};
    if (!patientId) {
      return res.status(400).json({ message: "patientId is required" });
    }

    const patient = await User.findById(patientId);
    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const doctorProfile = await DoctorProfile.findOne({ user: req.user.id });
    if (!doctorProfile) {
      return res.status(400).json({ message: "Doctor profile not found" });
    }

    const updated = await Block.findOneAndUpdate(
      { doctor: req.user.id, patient: patientId },
      {
        $set: {
          doctor: req.user.id,
          patient: patientId,
          ...(blockChat !== undefined ? { blockChat: !!blockChat } : {}),
          ...(blockBooking !== undefined ? { blockBooking: !!blockBooking } : {}),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({ block: updated });
  } catch (err) {
    console.error("Block set error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Get block status for a patient (doctor scope)
router.get("/:patientId", authMiddleware, authMiddleware.requireRole("doctor"), async (req, res) => {
  try {
    const { patientId } = req.params;
    const block = await Block.findOne({ doctor: req.user.id, patient: patientId }).lean();
    return res.json({
      block: block || { blockChat: false, blockBooking: false },
    });
  } catch (err) {
    console.error("Block fetch error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
