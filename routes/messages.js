const express = require("express");
const crypto = require("crypto");
const authMiddleware = require("../middleware/authMiddleware");
const Appointment = require("../models/Appointment");
const Message = require("../models/Message");
const DoctorProfile = require("../models/DoctorProfile");
const Block = require("../models/Block");

const router = express.Router();
const ALGO = "aes-256-gcm";
const KEY = (process.env.MESSAGE_KEY || "").slice(0, 32).padEnd(32, "0");

const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${enc.toString("hex")}.${tag.toString("hex")}`;
};

const decrypt = (payload) => {
  try {
    const [ivHex, dataHex, tagHex] = String(payload || "").split(".");
    if (!ivHex || !dataHex || !tagHex) return "";
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch (err) {
    return "";
  }
};

const canAccessAppointment = async (user, appointmentId) => {
  const appointment = await Appointment.findById(appointmentId)
    .populate("doctorProfile")
    .populate("user");
  if (!appointment) return null;
  const isPatient = appointment.user && appointment.user._id.equals(user._id);
  const isDoctor =
    appointment.doctorProfile &&
    (appointment.doctorProfile.user?.equals(user._id) || user.role === "doctor");
  return isPatient || isDoctor ? appointment : null;
};

const mapMessage = (doc) => {
  const base = doc || {};
  const replyDoc = base.replyTo || null;
  return {
    _id: base._id,
    appointmentId: base.appointmentId,
    senderType: base.senderType,
    senderId: base.senderId,
    text: base.deleted ? "" : decrypt(base.text),
    createdAt: base.createdAt,
    deleted: !!base.deleted,
    replyTo: replyDoc
      ? {
          _id: replyDoc._id,
          text: replyDoc.deleted ? "" : decrypt(replyDoc.text),
          senderType: replyDoc.senderType,
          deleted: !!replyDoc.deleted,
        }
      : null,
  };
};

router.get("/:appointmentId", authMiddleware, async (req, res) => {
  try {
    const appointmentId = req.params.appointmentId;
    const appointment = await canAccessAppointment(req.user, appointmentId);
    if (!appointment) {
      return res.status(403).json({ message: "Not authorized" });
    }
    const docs = await Message.find({ appointmentId })
      .sort({ createdAt: 1 })
      .populate("replyTo")
      .lean();
    const items = docs.map(mapMessage);
    res.json({ messages: items });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/:appointmentId", authMiddleware, async (req, res) => {
  try {
    const appointmentId = req.params.appointmentId;
    const { text, replyTo } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ message: "Message is required" });
    }
    const appointment = await canAccessAppointment(req.user, appointmentId);
    if (!appointment) {
      return res.status(403).json({ message: "Not authorized" });
    }
    // Admin/doctor-level chat control
    if (req.user.role === "doctor") {
      const profile = await DoctorProfile.findOne({ user: req.user._id }).select("isChatEnabled");
      if (profile && profile.isChatEnabled === false) {
        return res.status(403).json({ message: "تم تعطيل المحادثة لهذا الطبيب" });
      }
    }
    // Block chat: prevent patient from sending if doctor blocked chat
    if (req.user.role !== "doctor") {
      const doctorUserId = appointment.doctorProfile?.user;
      const patientUserId = appointment.user?._id;
      if (doctorUserId && patientUserId) {
        const block = await Block.findOne({ doctor: doctorUserId, patient: patientUserId });
        if (block?.blockChat) {
          return res.status(403).json({ message: "تم حظر المراسلة من الطبيب" });
        }
      }
    }
    let replyDoc = null;
    if (replyTo) {
      replyDoc = await Message.findById(replyTo);
      if (!replyDoc || String(replyDoc.appointmentId) !== String(appointmentId)) {
        return res.status(400).json({ message: "Invalid reply target" });
      }
    }
    const senderType = req.user.role === "doctor" ? "doctor" : "patient";
    const encrypted = encrypt(text.trim());
    const message = await Message.create({
      appointmentId,
      senderType,
      senderId: req.user._id,
      replyTo: replyDoc ? replyDoc._id : null,
      text: encrypted,
      encrypted: true,
    });
    const populated = await Message.findById(message._id).populate("replyTo");
    res.status(201).json({
      message: mapMessage(populated),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/:appointmentId/:messageId", authMiddleware, async (req, res) => {
  try {
    const { appointmentId, messageId } = req.params;
    const appointment = await canAccessAppointment(req.user, appointmentId);
    if (!appointment) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (req.user.role !== "doctor") {
      return res.status(403).json({ message: "Only doctor can delete messages" });
    }
    const message = await Message.findById(messageId);
    if (!message || String(message.appointmentId) !== String(appointmentId)) {
      return res.status(404).json({ message: "Message not found" });
    }
    message.deleted = true;
    message.deletedAt = new Date();
    await message.save();
    res.json({ messageId });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
