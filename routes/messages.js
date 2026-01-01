const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const authMiddleware = require("../middleware/authMiddleware");
const Appointment = require("../models/Appointment");
const Message = require("../models/Message");
const DoctorProfile = require("../models/DoctorProfile");
const Block = require("../models/Block");

const router = express.Router();
const ALGO = "aes-256-gcm";
const KEY = (process.env.MESSAGE_KEY || "").slice(0, 32).padEnd(32, "0");

const uploadsDir = path.join(__dirname, "..", "uploads", "messages");
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
} catch (e) {
  // ignore
}

const inferImageExt = (mimeType, originalName) => {
  const byName = String(originalName || "").toLowerCase();
  const dot = byName.lastIndexOf(".");
  if (dot > -1 && dot < byName.length - 1) {
    const ext = byName.slice(dot);
    if (/^\.(png|jpe?g|gif|webp|heic)$/.test(ext)) return ext;
  }
  const mt = String(mimeType || "").toLowerCase();
  if (mt.includes("png")) return ".png";
  if (mt.includes("webp")) return ".webp";
  if (mt.includes("gif")) return ".gif";
  if (mt.includes("heic") || mt.includes("heif")) return ".heic";
  return ".jpg";
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const appointmentId = String(req.params.appointmentId || "unknown");
      const ext = inferImageExt(file?.mimetype, file?.originalname);
      const rand = crypto.randomBytes(8).toString("hex");
      cb(null, `chat-${appointmentId}-${Date.now()}-${rand}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const mt = String(file?.mimetype || "").toLowerCase();
    if (mt.startsWith("image/")) return cb(null, true);
    return cb(new Error("Only image uploads are allowed"), false);
  },
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

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

// Upload an image for chat, returns a public URL to be sent as a normal message.
router.post("/:appointmentId/upload", authMiddleware, async (req, res) => {
  const appointmentId = req.params.appointmentId;
  try {
    const appointment = await canAccessAppointment(req.user, appointmentId);
    if (!appointment) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Admin/doctor-level chat control
    if (req.user.role === "doctor") {
      const profile = await DoctorProfile.findOne({ user: req.user._id }).select(
        "isChatEnabled"
      );
      if (profile && profile.isChatEnabled === false) {
        return res.status(403).json({ message: "تم تعطيل المحادثة لهذا الطبيب" });
      }
    }

    // Block chat upload for patients if doctor blocked chat
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

    return upload.single("file")(req, res, (err) => {
      if (err) {
        const msg = err?.message || "Upload failed";
        const isTooLarge = /file too large/i.test(msg);
        return res.status(isTooLarge ? 413 : 400).json({ message: msg });
      }
      if (!req.file) {
        return res.status(400).json({ message: "File is required" });
      }
      // Return relative URL so clients can prefix API_BASE_URL
      return res.status(201).json({
        url: `/uploads/messages/${req.file.filename}`,
      });
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
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
