// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const dotenv = require("dotenv");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const connectDB = require("./config/db");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const Message = require("./models/Message");
const Appointment = require("./models/Appointment");
const DoctorProfile = require("./models/DoctorProfile");
const User = require("./models/User");
const Block = require("./models/Block");

dotenv.config();
connectDB();

const app = express();
const server = http.createServer(app);

// CORS: allow configured origins only (comma-separated in env) or fallback to '*'
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : ["*"];
app.use(
  cors({
    origin: allowedOrigins,
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

app.get("/", (req, res) => {
  res.send("MediCare API Running...");
});

// Auth + domain routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/appointments", require("./routes/appointments"));
app.use("/api/doctors", require("./routes/doctors"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/blocks", require("./routes/blocks"));
// Admin routes (protected)
app.use("/api/admin", require("./routes/admin"));

// 🔔 Notifications routes
const { router: notificationsRouter } = require("./routes/notifications");
app.use("/api/notifications", notificationsRouter);

const PORT = process.env.PORT || 5001;
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization"],
  },
  transports: ["websocket", "polling"],
});

const AUTH_ERROR = "Unauthorized";
const ALGO = "aes-256-gcm";
const crypto = require("crypto");
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

const buildReplyMeta = (replyDoc) => {
  if (!replyDoc) return null;
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
    appointment.doctorProfile &&
    (appointment.doctorProfile.user?.equals(user._id) || user.role === "doctor");
  return isPatient || isDoctor ? { user, appointment } : null;
};

io.use(async (socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization?.replace("Bearer ", "");
    if (!token) return next(new Error(AUTH_ERROR));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
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

  socket.on("message", async ({ appointmentId, text, replyTo }) => {
    if (!text || !appointmentId) return;
    const access = await canAccessAppointment(socket.userId, appointmentId);
    if (!access) return socket.emit("error", AUTH_ERROR);

    const senderType = access.user.role === "doctor" ? "doctor" : "patient";
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
    const encrypted = encrypt(String(text));
    const saved = await Message.create({
      appointmentId,
      senderType,
      senderId: access.user._id,
      replyTo: replyDoc ? replyDoc._id : null,
      text: encrypted,
      encrypted: true,
    });

    const payload = {
      _id: saved._id,
      appointmentId,
      senderType,
      senderId: access.user._id,
      text,
      createdAt: saved.createdAt,
      deleted: false,
      replyTo: buildReplyMeta(replyDoc),
    };

    io.to(String(appointmentId)).emit("message", payload);
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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
