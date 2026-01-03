const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const authMiddleware = require("../middleware/authMiddleware");
const Appointment = require("../models/Appointment");
const Message = require("../models/Message");
const AuditLog = require("../models/AuditLog");
const DoctorProfile = require("../models/DoctorProfile");
const Block = require("../models/Block");
const User = require("../models/User");

const router = express.Router();
const { encryptAtRest, decryptAtRest, isLegacyMessageCryptoConfigured } = require("../utils/messageCrypto");

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
      const ext = inferImageExt(file?.mimetype, file?.originalname);
      const rand = crypto.randomBytes(8).toString("hex");
      cb(null, `chat-${Date.now()}-${rand}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const mt = String(file?.mimetype || "").toLowerCase();
    // Block SVG (scriptable) and restrict to common raster formats.
    if (mt === "image/svg+xml") return cb(new Error("SVG uploads are not allowed"), false);
    const allowed = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/heic",
      "image/heif",
    ]);
    if (allowed.has(mt)) return cb(null, true);
    return cb(new Error("Only image uploads are allowed"), false);
  },
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

const encrypt = (plain) => encryptAtRest(plain);
const decrypt = (payload) => decryptAtRest(payload);

const canAccessAppointment = async (user, appointmentId) => {
  const appointment = await Appointment.findById(appointmentId)
    .populate("doctorProfile")
    .populate("user");
  if (!appointment) return null;

  const userId = String(user?._id || user?.id || "");
  if (!userId) return null;

  const isPatient =
    !!appointment.user && String(appointment.user._id) === userId;
  const isDoctor =
    !!appointment.doctorProfile &&
    String(appointment.doctorProfile.user) === userId;

  return isPatient || isDoctor ? appointment : null;
};

const mapMessage = (doc) => {
  const base = doc || {};
  const replyDoc = base.replyTo || null;

  const mapContent = (m) => {
    if (!m) return { text: "", e2ee: null };
    if (m.deleted) return { text: "", e2ee: null };

    if (m.e2ee) {
      return {
        text: "",
        e2ee: {
          v: typeof m.e2eeVersion === "number" ? m.e2eeVersion : 1,
          alg: m.e2eeAlg || "x25519-xsalsa20-poly1305",
          nonce: m.e2eeNonce || "",
          ciphertext: m.e2eeCiphertext || "",
        },
      };
    }

    return {
      text: decrypt(m.text),
      e2ee: null,
    };
  };

  const content = mapContent(base);
  const replyContent = replyDoc ? mapContent(replyDoc) : null;

  return {
    _id: base._id,
    appointmentId: base.appointmentId,
    senderType: base.senderType,
    senderId: base.senderId,
    text: content.text,
    e2ee: content.e2ee,
    createdAt: base.createdAt,
    deleted: !!base.deleted,
    replyTo: replyDoc
      ? {
          _id: replyDoc._id,
          text: replyContent?.text || "",
          e2ee: replyContent?.e2ee || null,
          senderType: replyDoc.senderType,
          deleted: !!replyDoc.deleted,
        }
      : null,
  };
};

// Save/rotate current user's E2EE public key
router.put("/e2ee/key", authMiddleware, async (req, res) => {
  try {
    const publicKey = String(req.body?.publicKey || "").trim();
    if (!publicKey) {
      return res.status(400).json({ message: "publicKey is required" });
    }
    if (publicKey.length > 300) {
      return res.status(400).json({ message: "publicKey is too long" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    user.chatPublicKey = publicKey;
    await user.save();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

// Fetch the E2EE public keys for both participants of an appointment chat
router.get("/:appointmentId/e2ee/keys", authMiddleware, async (req, res) => {
  try {
    const appointmentId = req.params.appointmentId;
    const appointment = await canAccessAppointment(req.user, appointmentId);
    if (!appointment) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const doctorUserId = String(appointment.doctorProfile?.user || "");
    const patientUserId = String(appointment.user?._id || "");
    if (!doctorUserId || !patientUserId) {
      return res.status(400).json({ message: "Missing participants" });
    }

    const users = await User.find({ _id: { $in: [doctorUserId, patientUserId] } }).select(
      "_id chatPublicKey"
    );
    const byId = new Map(users.map((u) => [String(u._id), u]));

    const meId = String(req.user.id);
    const otherId = meId === doctorUserId ? patientUserId : doctorUserId;

    return res.json({
      appointmentId: String(appointmentId),
      me: {
        userId: meId,
        publicKey: String(byId.get(meId)?.chatPublicKey || ""),
      },
      other: {
        userId: otherId,
        publicKey: String(byId.get(otherId)?.chatPublicKey || ""),
      },
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

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
    // Legacy at-rest crypto is required for plaintext chat messages.
    if (!isLegacyMessageCryptoConfigured() && !(req.body && req.body.e2ee)) {
      return res.status(500).json({ message: "Server misconfigured: MESSAGE_KEY is missing" });
    }
    const appointmentId = req.params.appointmentId;
    const { text, replyTo, e2ee } = req.body || {};
    const appointment = await canAccessAppointment(req.user, appointmentId);
    if (!appointment) {
      return res.status(403).json({ message: "Not authorized" });
    }
    // Admin/doctor-level chat control
    if (req.user.role === "doctor") {
      const profile = await DoctorProfile.findOne({ user: req.user.id }).select("isChatEnabled");
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

    let message;

    // E2EE message: store ciphertext only.
    if (e2ee && typeof e2ee === "object") {
      const nonce = String(e2ee.nonce || "").trim();
      const ciphertext = String(e2ee.ciphertext || "").trim();
      const alg = String(e2ee.alg || "x25519-xsalsa20-poly1305").trim();
      const vRaw = e2ee.v;
      const v = typeof vRaw === "number" ? vRaw : Number(vRaw || 1);

      if (!nonce || !ciphertext) {
        return res.status(400).json({ message: "Invalid e2ee payload" });
      }
      if (nonce.length > 200 || ciphertext.length > 50000) {
        return res.status(400).json({ message: "e2ee payload too large" });
      }

      message = await Message.create({
        appointmentId,
        senderType,
        senderId: req.user.id,
        replyTo: replyDoc ? replyDoc._id : null,
        e2ee: true,
        e2eeVersion: Number.isFinite(v) && v >= 1 ? v : 1,
        e2eeAlg: alg || "x25519-xsalsa20-poly1305",
        e2eeNonce: nonce,
        e2eeCiphertext: ciphertext,
        encrypted: true,
      });
    } else {
      // Legacy (server-side) encryption
      if (!text || !String(text).trim()) {
        return res.status(400).json({ message: "Message is required" });
      }
      const encrypted = encrypt(String(text).trim());
      message = await Message.create({
        appointmentId,
        senderType,
        senderId: req.user.id,
        replyTo: replyDoc ? replyDoc._id : null,
        text: encrypted,
        encrypted: true,
        e2ee: false,
      });
    }
    const populated = await Message.findById(message._id).populate("replyTo");
    const mapped = mapMessage(populated);

    // Broadcast to room for real-time delivery (covers REST fallback when sender socket is offline)
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(String(appointmentId)).emit("message", mapped);
      }
    } catch (e) {
      // ignore broadcast failures
    }
    res.status(201).json({
      message: mapped,
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
      const profile = await DoctorProfile.findOne({ user: req.user.id }).select(
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

    // Broadcast deletion for real-time sync
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(String(appointmentId)).emit("messageDeleted", {
          _id: String(messageId),
          appointmentId: String(appointmentId),
        });
      }
    } catch (e) {
      // ignore broadcast failures
    }
    res.json({ messageId });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// Report a message (UGC moderation). Stores an audit log entry for review.
router.post("/:appointmentId/:messageId/report", authMiddleware, async (req, res) => {
  try {
    const { appointmentId, messageId } = req.params;
    const { reason } = req.body || {};

    const appointment = await canAccessAppointment(req.user, appointmentId);
    if (!appointment) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const message = await Message.findById(messageId).select(
      "_id appointmentId senderType senderId createdAt deleted"
    );
    if (!message || String(message.appointmentId) !== String(appointmentId)) {
      return res.status(404).json({ message: "Message not found" });
    }

    const safeReason = String(reason || "").trim().slice(0, 500);
    const forwarded = req.headers["x-forwarded-for"];
    const ip = Array.isArray(forwarded)
      ? forwarded[0]
      : String(forwarded || req.ip || "").split(",")[0].trim();

    await AuditLog.create({
      actorUser: req.user.id,
      actorName: String(req.user?.name || req.user?.fullName || "").trim(),
      action: "REPORT_MESSAGE",
      entityType: "Message",
      entityId: String(messageId),
      entityName: String(appointmentId),
      details: JSON.stringify({
        appointmentId: String(appointmentId),
        messageId: String(messageId),
        messageSenderType: message.senderType,
        messageSenderId: String(message.senderId || ""),
        messageDeleted: !!message.deleted,
        reason: safeReason,
      }),
      ip,
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
