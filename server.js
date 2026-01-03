// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const dotenv = require("dotenv");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const connectDB = require("./config/db");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const Message = require("./models/Message");
const Appointment = require("./models/Appointment");
const DoctorProfile = require("./models/DoctorProfile");
const User = require("./models/User");
const Block = require("./models/Block");
const DoctorProfileModel = require("./models/DoctorProfile");
const { startReminderJobs } = require("./jobs/reminders");
const authMiddleware = require("./middleware/authMiddleware");
const { encryptAtRest, decryptAtRest, isLegacyMessageCryptoConfigured } = require("./utils/messageCrypto");

dotenv.config();
connectDB();

// Fail fast on missing critical secrets in production.
if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is missing in production");
    process.exit(1);
  }
  const rawMsgKey = String(process.env.MESSAGE_KEY || "");
  if (!rawMsgKey) {
    console.error("MESSAGE_KEY is missing in production");
    process.exit(1);
  }
  if (rawMsgKey.length < 32) {
    console.error("MESSAGE_KEY is too short in production (must be >= 32 chars)");
    process.exit(1);
  }
}

const app = express();
const server = http.createServer(app);

// CORS: allow configured origins only (comma-separated in env) or fallback to allow-all.
// NOTE: In the `cors` package, an array like ["*"] does NOT mean allow-all.
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : null;

const corsOriginOption =
  !allowedOrigins || allowedOrigins.includes("*") ? "*" : allowedOrigins;
app.use(
  cors({
    origin: corsOriginOption,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Compress API responses (JSON, etc.)
app.use(compression());

// Global rate limit
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// Tighter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/auth", authLimiter);
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Health check (always available)
app.get("/api/health", (req, res) => {
  res.json({ ok: true, name: "MediCare API", ts: new Date().toISOString() });
});

// Auth + domain routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/appointments", require("./routes/appointments"));

// Doctor profile update override: allows saving map coordinates (lat/lng).
// (We keep this here because routes/doctors.js has a legacy encoding issue.)
app.patch("/api/doctors/me/profile", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const updates = {};
    const fields = [
      "displayName",
      "specialty",
      "specialtyLabel",
      "location",
      "certification",
      "cv",
      "licenseNumber",
      "avatarUrl",
      "secretaryPhone",
    ];

    fields.forEach((field) => {
      if (typeof req.body[field] === "string") {
        updates[field] = req.body[field].trim();
      }
    });

    if (typeof req.body.consultationFee !== "undefined") {
      const fee = Number(req.body.consultationFee);
      if (!Number.isNaN(fee)) {
        updates.consultationFee = fee;
      }
    }

    if (typeof req.body.locationLat !== "undefined" || typeof req.body.locationLng !== "undefined") {
      const lat = Number(req.body.locationLat);
      const lng = Number(req.body.locationLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ message: "إحداثيات الموقع غير صحيحة" });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ message: "إحداثيات الموقع خارج النطاق" });
      }
      updates.locationLat = lat;
      updates.locationLng = lng;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No profile data provided" });
    }

    Object.assign(profile, updates);
    await profile.save();

    return res.json({ doctor: profile });
  } catch (err) {
    console.error("Update profile error:", err?.message);
    return res.status(500).json({ message: "Server error" });
  }
});

app.use("/api/doctors", require("./routes/doctors"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/blocks", require("./routes/blocks"));
// Admin routes (protected)
app.use("/api/admin", require("./routes/admin"));

// Serve uploaded files (e.g., chat images)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 🔔 Notifications routes
const { router: notificationsRouter } = require("./routes/notifications");
app.use("/api/notifications", notificationsRouter);

// Optional: Serve Admin dashboard from the same server (same-origin)
// Usage:
// 1) Build Admin: (in Admin/) npm run build
// 2) Set env SERVE_ADMIN=true
// 3) (Optional) ADMIN_DIST=/absolute/path/to/Admin/dist
if (String(process.env.SERVE_ADMIN || "").toLowerCase() === "true") {
  const adminDist = process.env.ADMIN_DIST
    ? path.resolve(process.env.ADMIN_DIST)
    : path.resolve(__dirname, "..", "Admin", "dist");

  const indexHtml = path.join(adminDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(adminDist));
    // Root should serve the Admin app when enabled.
    app.get("/", (req, res) => {
      res.sendFile(indexHtml);
    });
    // SPA fallback (do not intercept /api/*)
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.sendFile(indexHtml);
    });
    console.log("Serving Admin dashboard from:", adminDist);
  } else {
    console.warn(
      "SERVE_ADMIN=true لكن لم يتم العثور على Admin dist. Build Admin أولاً:",
      indexHtml
    );
  }
}

// Default root response when Admin is not being served
app.get("/", (req, res) => {
  res.send("MediCare API Running...");
});

const PORT = process.env.PORT || 5001;
const io = new Server(server, {
  cors: {
    origin: corsOriginOption,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization"],
  },
  transports: ["websocket", "polling"],
});

const AUTH_ERROR = "Unauthorized";
const encrypt = (plain) => encryptAtRest(plain);
const decrypt = (payload) => decryptAtRest(payload);

const buildReplyMeta = (replyDoc) => {
  if (!replyDoc) return null;
  if (replyDoc.e2ee) {
    return {
      _id: replyDoc._id,
      text: "",
      e2ee: {
        v: typeof replyDoc.e2eeVersion === "number" ? replyDoc.e2eeVersion : 1,
        alg: replyDoc.e2eeAlg || "x25519-xsalsa20-poly1305",
        nonce: replyDoc.e2eeNonce || "",
        ciphertext: replyDoc.e2eeCiphertext || "",
      },
      senderType: replyDoc.senderType,
      deleted: !!replyDoc.deleted,
    };
  }
  return {
    _id: replyDoc._id,
    text: replyDoc.deleted ? "" : decrypt(replyDoc.text),
    senderType: replyDoc.senderType,
    deleted: !!replyDoc.deleted,
  };
};

const canAccessAppointment = async (userId, appointmentId) => {
  const user = await User.findById(userId);
  if (!user) return null;
  const appointment = await Appointment.findById(appointmentId)
    .populate("doctorProfile")
    .populate("user");
  if (!appointment) return null;
  const isPatient = appointment.user && appointment.user._id.equals(user._id);
  const isDoctor =
    appointment.doctorProfile && appointment.doctorProfile.user?.equals(user._id);
  return isPatient || isDoctor ? { user, appointment } : null;
};

io.use(async (socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization?.replace("Bearer ", "");
    if (!token) return next(new Error(AUTH_ERROR));
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Reject refresh tokens for socket access
    if (payload?.typ && payload.typ !== "access") {
      return next(new Error(AUTH_ERROR));
    }

    const user = await User.findById(payload.id).select("role tokenVersion");
    if (!user) return next(new Error(AUTH_ERROR));

    // Enforce tokenVersion (logout-all / password-change invalidation)
    const tokenVer = typeof payload?.ver === "number" ? payload.ver : 0;
    const userVer = typeof user?.tokenVersion === "number" ? user.tokenVersion : 0;
    if (tokenVer !== userVer) {
      return next(new Error(AUTH_ERROR));
    }

    if (user.role === "doctor") {
      const profile = await DoctorProfileModel.findOne({ user: user._id }).select(
        "status subscriptionEndsAt subscriptionGraceEndsAt"
      );
      if (!profile) return next(new Error(AUTH_ERROR));
      if (profile.status !== "active") return next(new Error(AUTH_ERROR));
      if (!profile.subscriptionEndsAt) return next(new Error(AUTH_ERROR));
      const cutoff = profile.subscriptionGraceEndsAt || profile.subscriptionEndsAt;
      const cutoffMs = new Date(cutoff).getTime();
      if (!Number.isNaN(cutoffMs) && Date.now() > cutoffMs) {
        return next(new Error(AUTH_ERROR));
      }
    }

    socket.userId = payload.id;
    next();
  } catch (err) {
    next(new Error(AUTH_ERROR));
  }
});

io.on("connection", (socket) => {
  socket.on("join", async ({ appointmentId }) => {
    const access = await canAccessAppointment(socket.userId, appointmentId);
    if (!access) return socket.emit("error", AUTH_ERROR);
    socket.join(String(appointmentId));
  });

  socket.on("message", async ({ appointmentId, text, replyTo, e2ee }) => {
    if (!appointmentId) return;
    const access = await canAccessAppointment(socket.userId, appointmentId);
    if (!access) return socket.emit("error", AUTH_ERROR);

    const senderType = access.user.role === "doctor" ? "doctor" : "patient";

    // Admin/doctor-level chat control
    if (senderType === "doctor") {
      const profile = await DoctorProfileModel.findOne({ user: access.user._id }).select("isChatEnabled");
      if (profile && profile.isChatEnabled === false) {
        return socket.emit("error", "تم تعطيل المحادثة لهذا الطبيب");
      }
    }

    // Block chat if doctor blocked patient
    const doctorUserId = access.appointment?.doctorProfile?.user;
    const patientUserId = access.appointment?.user?._id;
    if (senderType === "patient" && doctorUserId && patientUserId) {
      const block = await Block.findOne({
        doctor: doctorUserId,
        patient: patientUserId,
      });
      if (block?.blockChat) {
        return socket.emit("error", "تم حظر المراسلة من هذا الطبيب");
      }
    }
    let replyDoc = null;
    if (replyTo) {
      replyDoc = await Message.findById(replyTo);
      if (!replyDoc || String(replyDoc.appointmentId) !== String(appointmentId)) {
        return socket.emit("error", "Invalid reply target");
      }
    }

    // E2EE path (preferred): store ciphertext + broadcast ciphertext only.
    if (e2ee && typeof e2ee === "object") {
      const nonce = String(e2ee.nonce || "").trim();
      const ciphertext = String(e2ee.ciphertext || "").trim();
      const alg = String(e2ee.alg || "x25519-xsalsa20-poly1305").trim();
      const vRaw = e2ee.v;
      const v = typeof vRaw === "number" ? vRaw : Number(vRaw || 1);

      if (!nonce || !ciphertext) return;

      const saved = await Message.create({
        appointmentId,
        senderType,
        senderId: access.user._id,
        replyTo: replyDoc ? replyDoc._id : null,
        e2ee: true,
        e2eeVersion: Number.isFinite(v) && v >= 1 ? v : 1,
        e2eeAlg: alg || "x25519-xsalsa20-poly1305",
        e2eeNonce: nonce,
        e2eeCiphertext: ciphertext,
        encrypted: true,
      });

      const payload = {
        _id: saved._id,
        appointmentId,
        senderType,
        senderId: access.user._id,
        text: "",
        e2ee: {
          v: saved.e2eeVersion,
          alg: saved.e2eeAlg,
          nonce: saved.e2eeNonce,
          ciphertext: saved.e2eeCiphertext,
        },
        createdAt: saved.createdAt,
        deleted: false,
        replyTo: buildReplyMeta(replyDoc),
      };

      io.to(String(appointmentId)).emit("message", payload);
      return;
    }

    // Legacy path: server-side encrypt at rest + broadcast plaintext for older clients.
    if (!text) return;
    const encrypted = encrypt(String(text));
    const saved = await Message.create({
      appointmentId,
      senderType,
      senderId: access.user._id,
      replyTo: replyDoc ? replyDoc._id : null,
      text: encrypted,
      encrypted: true,
      e2ee: false,
    });

    io.to(String(appointmentId)).emit("message", {
      _id: saved._id,
      appointmentId,
      senderType,
      senderId: access.user._id,
      text,
      createdAt: saved.createdAt,
      deleted: false,
      replyTo: buildReplyMeta(replyDoc),
    });
  });

  socket.on("deleteMessage", async ({ appointmentId, messageId }) => {
    if (!appointmentId || !messageId) return;
    const access = await canAccessAppointment(socket.userId, appointmentId);
    if (!access) return socket.emit("error", AUTH_ERROR);
    if (access.user.role !== "doctor") {
      return socket.emit("error", "Only doctor can delete messages");
    }
    const message = await Message.findById(messageId);
    if (!message || String(message.appointmentId) !== String(appointmentId)) {
      return socket.emit("error", "Message not found");
    }
    message.deleted = true;
    message.deletedAt = new Date();
    await message.save();
    io.to(String(appointmentId)).emit("messageDeleted", {
      _id: messageId,
      appointmentId,
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  const disableReminders = String(process.env.DISABLE_REMINDERS || "").toLowerCase() === "true";
  if (disableReminders) {
    console.log("Reminder jobs are disabled (DISABLE_REMINDERS=true)");
  } else {
    startReminderJobs();
  }
});
