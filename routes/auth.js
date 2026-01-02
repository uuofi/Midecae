// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const DoctorProfile = require("../models/DoctorProfile");
const Appointment = require("../models/Appointment");
const DoctorService = require("../models/DoctorService");
const Block = require("../models/Block");
const Message = require("../models/Message");
const AuditLog = require("../models/AuditLog");
const authMiddleware = require("../middleware/authMiddleware");
const sendSms = require("../utils/sendSms");
const rateLimit = require("express-rate-limit");

const normalizePhone = (phone) => {
  let p = String(phone || "").replace(/\s|-/g, "").trim();
  // إذا الرقم يبدأ بـ +964 ويليه 10 أرقام
  if (/^\+964\d{10}$/.test(p)) return p;
  // إذا الرقم يبدأ بـ 0 ويليه 10 أرقام
  if (/^0\d{10}$/.test(p)) return '+964' + p.slice(1);
  // إذا الرقم فقط 10 أرقام (بدون صفر أو +964)
  if (/^\d{10}$/.test(p)) return '+964' + p;
  return p;
};
// يقبل أرقام عراقية تبدأ بـ 07 أو +964 (أي 11 أو 12 رقم بعد 0 أو +)
const isValidPhone = (phone) => {
  const p = normalizePhone(phone);
  if (/^07[0-9]{9}$/.test(p)) return true;
  // +96478XXXXXXXXX أو +96477XXXXXXXXX أو +96479XXXXXXXXX أو +96475XXXXXXXXX (12 رقم بعد +)
  if (/^\+964[0-9]{10}$/.test(p)) return true;
  return false;
};
const isStrongPassword = (pwd) =>
  typeof pwd === "string" &&
  pwd.length >= 8 &&
  /[A-Z]/.test(pwd) &&
  /[a-z]/.test(pwd) &&
  /\d/.test(pwd);

// Ensure doctor names always start with the Arabic prefix "د. "
const ensureDoctorPrefix = (rawName = "") => {
  const name = String(rawName || "").trim();
  if (!name) return name;
  const prefixPattern = /^د\s*\.?\s*/i;
  const stripped = prefixPattern.test(name) ? name.replace(prefixPattern, "").trim() : name;
  return `د. ${stripped}`;
};

const router = express.Router();

// Rate limiting (defense-in-depth; server.js already limits /api/auth)
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "محاولات كثيرة. حاول لاحقاً." },
});

const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "محاولات كثيرة. حاول لاحقاً." },
});

const refreshLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "محاولات كثيرة. حاول لاحقاً." },
});

const passwordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "محاولات كثيرة. حاول لاحقاً." },
});

const isSubscriptionActive = (profile) => {
  if (!profile) return false;
  if (!profile.subscriptionEndsAt) return false;
  const cutoff = profile.subscriptionGraceEndsAt || profile.subscriptionEndsAt;
  const cutoffMs = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffMs)) return false;
  return Date.now() <= cutoffMs;
};

const audit = async (req, { actorUser, actorName, action, entityType, entityId, entityName, details }) => {
  try {
    await AuditLog.create({
      actorUser: actorUser || null,
      actorName: actorName || "",
      action,
      entityType,
      entityId: entityId ? String(entityId) : "",
      entityName: entityName || "",
      details: details || "",
      ip: req?.ip || "",
    });
  } catch (e) {
    // ignore audit failures
  }
};

// Access token
const generateToken = (user) =>
  jwt.sign(
    {
      id: user._id,
      phone: user.phone,
      role: user.role,
      ver: typeof user.tokenVersion === "number" ? user.tokenVersion : 0,
      typ: "access",
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
  );

// Refresh token (long lived)
const generateRefreshToken = (user) =>
  jwt.sign(
    {
      id: user._id,
      ver: typeof user.tokenVersion === "number" ? user.tokenVersion : 0,
      typ: "refresh",
      rnd: crypto.randomBytes(8).toString("hex"),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "90d" }
  );

const ensureDoctorAccessOk = async (user) => {
  if (!user || user.role !== "doctor") return { ok: true };
  const profile = await DoctorProfile.findOne({ user: user._id }).select(
    "status subscriptionEndsAt subscriptionGraceEndsAt isAcceptingBookings isChatEnabled"
  );
  if (!profile) return { ok: false, status: 403, message: "Doctor profile not found" };
  if (profile.status !== "active") return { ok: false, status: 403, message: "بانتظار موافقة الادمن" };
  if (!isSubscriptionActive(profile)) return { ok: false, status: 403, message: "الاشتراك منتهي" };
  return { ok: true };
};

/**
 * @route   POST /api/auth/register
 * @desc    Register user + send verification code
 * @access  Public
 */
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      password,
      role = "patient",
      doctorSpecialty,
      doctorSpecialtySlug,
      licenseNumber,
      avatarUrl,
      location,
      locationLat,
      locationLng,
      certification,
      cv,
      secretaryPhone,
      consultationFee,
      age,
    } = req.body;

    // Never allow public registration as admin.
    if (role === "admin") {
      return res.status(403).json({ message: "غير مسموح إنشاء حساب أدمن عبر التسجيل" });
    }

    if (!name || !phone || !password)
      return res.status(400).json({ message: "الاسم ورقم الجوال وكلمة المرور مطلوبة" });

    if (!isValidPhone(phone)) {
      return res.status(400).json({ message: "صيغة رقم الجوال غير صحيحة" });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({ message: "كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي حروف كبيرة وصغيرة ورقم" });
    }

    if (age !== undefined) {
      const parsedAge = Number(age);
      if (!Number.isFinite(parsedAge) || parsedAge < 1 || parsedAge > 120) {
        return res.status(400).json({ message: "العمر يجب أن يكون رقمًا بين 1 و 120" });
      }
    }

    let parsedFee = 0;
    if (role === "doctor") {
      if (
        !doctorSpecialty ||
        !doctorSpecialtySlug ||
        !licenseNumber ||
        !avatarUrl ||
        !location ||
        !certification ||
        !cv ||
        (!consultationFee && consultationFee !== 0)
      ) {
        return res
          .status(400)
          .json({ message: "بيانات الطبيب ناقصة: كل الحقول المهنية مطلوبة" });
      }

      if (!secretaryPhone) {
        return res.status(400).json({ message: "رقم السكرتير مطلوب" });
      }

      if (!isValidPhone(secretaryPhone)) {
        return res.status(400).json({ message: "صيغة رقم السكرتير غير صحيحة" });
      }

      parsedFee = Number(consultationFee);
      if (!Number.isFinite(parsedFee) || parsedFee <= 0) {
        return res.status(400).json({ message: "أتعاب الاستشارة يجب أن تكون رقمًا موجبًا" });
      }

      if (typeof locationLat !== "undefined" || typeof locationLng !== "undefined") {
        const lat = Number(locationLat);
        const lng = Number(locationLng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return res.status(400).json({ message: "إحداثيات الموقع غير صحيحة" });
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return res.status(400).json({ message: "إحداثيات الموقع خارج النطاق" });
        }
      }
    }


    const normalizedPhone = normalizePhone(phone);
    const existing = await User.findOne({ phone: normalizedPhone });
    if (existing)
      return res.status(409).json({ message: "رقم الجوال مسجل مسبقًا" });

    const hashed = await bcrypt.hash(password, 12);

    // كود تفعيل 6 أرقام
    // كود التحقق هو آخر 10 أرقام من رقم الهاتف (يبدأ من 7)
    // كود تفعيل 6 أرقام عشوائي
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const doctorSafeName = role === "doctor" ? ensureDoctorPrefix(name) : name;

    const user = await User.create({
      name: doctorSafeName,
      phone: normalizedPhone,
      email: email?.toLowerCase?.(),
      password: hashed,
      // OTP verification is currently disabled; mark as verified immediately.
      phoneVerified: true,
      verificationCode: null,
      role,
      age: age !== undefined ? Number(age) : undefined,
      tokenVersion: 0,
    });

    if (role === "doctor") {
      const normalizedSecretaryPhone = secretaryPhone
        ? normalizePhone(secretaryPhone)
        : undefined;
      const doctorProfile = await DoctorProfile.create({
        user: user._id,
        displayName: ensureDoctorPrefix(name),
        specialty: doctorSpecialty,
        specialtySlug: doctorSpecialtySlug,
        specialtyLabel: doctorSpecialty,
        licenseNumber,
        avatarUrl,
        location,
        locationLat:
          typeof locationLat !== "undefined" && locationLat !== null && locationLat !== ""
            ? Number(locationLat)
            : null,
        locationLng:
          typeof locationLng !== "undefined" && locationLng !== null && locationLng !== ""
            ? Number(locationLng)
            : null,
        certification,
        cv,
        secretaryPhone: normalizedSecretaryPhone,
        bio: cv,
        consultationFee: parsedFee,
        status: "pending",
        // No subscription on first registration.
        subscriptionStartsAt: null,
        subscriptionEndsAt: null,
        subscriptionGraceEndsAt: null,
      });
      user.doctorProfile = doctorProfile._id;
      await user.save();
    }



    // طباعة كود التحقق في التيرمنال
    console.log(`OTP for ${user.phone}: ${verificationCode}`);

          // OTP is disabled.
          // Patients can login immediately; doctors remain pending until admin approval.
          if (user.role === "doctor") {
            return res.status(201).json({
              message: "تم إنشاء الحساب وبانتظار موافقة الادمن",
              user: {
                id: user._id,
                name: user.name,
                phone: user.phone,
                role: user.role,
                doctorProfile: user.doctorProfile,
                age: user.age,
              },
            });
          }

    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    await audit(req, {
      actorUser: user._id,
      actorName: user.name,
      action: "REGISTER",
      entityType: "User",
      entityId: user._id,
      entityName: user.name,
      details: `role=${user.role}`,
    });
    return res.status(201).json({
      message: "تم إنشاء الحساب بنجاح",
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        doctorProfile: user.doctorProfile,
        age: user.age,
      },
      token,
      refreshToken,
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   POST /api/auth/verify
 * @desc    Verify email with code
 * @access  Public
 */
router.post("/verify", async (req, res) => {
  return res
    .status(410)
    .json({ message: "تم تعطيل OTP مؤقتاً. سجل دخولك مباشرة برقمك وكلمة المرور." });
});

/**
 * @route   POST /api/auth/resend
 * @desc    Resend verification code
 * @access  Public
 */
router.post("/resend", async (req, res) => {
  // تم تعطيل إعادة إرسال رمز التفعيل مؤقتاً
  return res.status(200).json({ message: "تم تعطيل إرسال رمز التفعيل مؤقتاً" });
});

/**
 * @route   POST /api/auth/login
 * @desc    Login user (only if email verified)
 * @access  Public
 */
/**
 * ------------- LOGIN STEP 1 -------------
 *  المستخدم يدخل إيميل + كلمة مرور
 *  نتحقق منهم → نرسل كود إلى الإيميل
 * -----------------------------------------
 */
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res
        .status(400)
        .json({ message: "رقم الجوال وكلمة المرور مطلوبان" });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({ message: "صيغة رقم الجوال غير صحيحة" });
    }

    const normalizedPhone = normalizePhone(phone);

    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) {
      return res.status(401).json({ message: "رقم الجوال أو كلمة المرور غير صحيحة" });
    }

    if (user.role === "patient" && user.isBlocked) {
      return res.status(403).json({ message: "الحساب محظور" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: "رقم الجوال أو كلمة المرور غير صحيحة" });
    }

    // OTP verification is currently disabled; auto-verify on successful login.
    if (!user.phoneVerified) {
      user.phoneVerified = true;
      user.verificationCode = null;
      await user.save();
    }

    // Admin hard lock: only the configured ADMIN_PHONE can login as admin.
    if (user.role === "admin" && process.env.ADMIN_PHONE) {
      const expectedAdminPhone = normalizePhone(process.env.ADMIN_PHONE);
      if (expectedAdminPhone && user.phone !== expectedAdminPhone) {
        return res.status(403).json({ message: "تسجيل دخول الأدمن مقيد برقم محدد" });
      }
    }

    const doctorCheck = await ensureDoctorAccessOk(user);
    if (!doctorCheck.ok) return res.status(doctorCheck.status).json({ message: doctorCheck.message });

    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    await audit(req, {
      actorUser: user._id,
      actorName: user.name,
      action: "LOGIN",
      entityType: "User",
      entityId: user._id,
      entityName: user.name,
      details: `role=${user.role}`,
    });
    return res.json({
      message: "تم تسجيل الدخول مباشرة (بدون رمز)",
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        doctorProfile: user.doctorProfile,
        age: user.age,
      },
      token,
      refreshToken,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});
/**
 * ------------- LOGIN STEP 2 -------------
 *  المستخدم يدخل الكود اللي وصله
 *  نتحقق من الكود → نرجع توكن ونسجل دخوله
 * -----------------------------------------
 */
router.post("/login/verify", async (req, res) => {
  return res
    .status(410)
    .json({ message: "تم تعطيل OTP مؤقتاً. استخدم تسجيل الدخول برقمك وكلمة المرور." });
});

/**
 * @route   POST /api/auth/refresh
 * @desc    Exchange refresh token for a new access token
 * @access  Public
 */
router.post("/refresh", refreshLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ message: "Refresh token مطلوب" });

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ message: "Refresh token غير صالح" });
    }

    if (decoded?.typ !== "refresh") {
      return res.status(401).json({ message: "Refresh token غير صالح" });
    }

    const user = await User.findById(decoded.id).select("role phone isBlocked tokenVersion name doctorProfile age");
    if (!user) return res.status(401).json({ message: "المستخدم غير موجود" });

    const tokenVer = typeof decoded?.ver === "number" ? decoded.ver : 0;
    const userVer = typeof user?.tokenVersion === "number" ? user.tokenVersion : 0;
    if (tokenVer !== userVer) {
      return res.status(401).json({ message: "Session expired" });
    }

    if (user.role === "patient" && user.isBlocked) {
      return res.status(403).json({ message: "الحساب محظور" });
    }

    const doctorCheck = await ensureDoctorAccessOk(user);
    if (!doctorCheck.ok) return res.status(doctorCheck.status).json({ message: doctorCheck.message });

    const newToken = generateToken(user);
    const newRefreshToken = generateRefreshToken(user);

    await audit(req, {
      actorUser: user._id,
      actorName: user.name,
      action: "REFRESH",
      entityType: "User",
      entityId: user._id,
      entityName: user.name,
      details: `role=${user.role}`,
    });

    return res.json({ token: newToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error("Refresh error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   GET /api/auth/me
 * @desc    Get current user
 * @access  Private
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");

    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    return res.json({ user });
  } catch (err) {
    console.error("Me error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   PATCH /api/auth/me
 * @desc    Update basic profile (name/phone/email)
 * @access  Private
 */
router.patch("/me", authMiddleware, async (req, res) => {
  try {
    const { name, phone, email, age } = req.body;

    if (!name && !phone && !email) {
      return res.status(400).json({ message: "يرجى إرسال حقل واحد على الأقل للتعديل" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    if (name) {
      user.name = name.toString().trim();
    }

    if (email !== undefined) {
      const cleanEmail = email ? email.toString().toLowerCase().trim() : undefined;
      user.email = cleanEmail || undefined;
    }

    if (age !== undefined) {
      const parsedAge = Number(age);
      if (!Number.isFinite(parsedAge) || parsedAge < 1 || parsedAge > 120) {
        return res.status(400).json({ message: "العمر يجب أن يكون رقمًا بين 1 و 120" });
      }
      user.age = parsedAge;
    }

    if (phone) {
      if (!isValidPhone(phone)) {
        return res.status(400).json({ message: "صيغة رقم الجوال غير صحيحة" });
      }
      const normalizedPhone = normalizePhone(phone);
      const duplicate = await User.findOne({ phone: normalizedPhone, _id: { $ne: user._id } });
      if (duplicate) {
        return res.status(409).json({ message: "رقم الجوال مستخدم من حساب آخر" });
      }
      user.phone = normalizedPhone;
      // عند تغيير الرقم نعيد التفعيل لاحقًا إذا لزم
    }

    await user.save();

    await audit(req, {
      actorUser: user._id,
      actorName: user.name,
      action: "UPDATE_PROFILE",
      entityType: "User",
      entityId: user._id,
      entityName: user.name,
      details: "updated basic profile",
    });

    return res.json({
      message: "تم تحديث الحساب بنجاح",
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        age: user.age,
        email: user.email,
        role: user.role,
        doctorProfile: user.doctorProfile,
      },
    });
  } catch (err) {
    console.error("Update profile error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   PATCH /api/auth/me/password
 * @desc    Change password (requires current password)
 * @access  Private
 */
router.patch("/me/password", passwordLimiter, authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "كلمة المرور الحالية والجديدة مطلوبة" });
    }
    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ message: "كلمة المرور الجديدة ضعيفة (حروف كبيرة/صغيرة + رقم و 8 أحرف+)" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    const match = await bcrypt.compare(String(currentPassword), user.password);
    if (!match) return res.status(401).json({ message: "كلمة المرور الحالية غير صحيحة" });

    user.password = await bcrypt.hash(String(newPassword), 12);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    await audit(req, {
      actorUser: user._id,
      actorName: user.name,
      action: "CHANGE_PASSWORD",
      entityType: "User",
      entityId: user._id,
      entityName: user.name,
      details: "password changed + session invalidated",
    });

    return res.json({ message: "تم تغيير كلمة المرور", token, refreshToken });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   POST /api/auth/logout-all
 * @desc    Logout from all devices by bumping tokenVersion
 * @access  Private
 */
router.post("/logout-all", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await audit(req, {
      actorUser: user._id,
      actorName: user.name,
      action: "LOGOUT_ALL",
      entityType: "User",
      entityId: user._id,
      entityName: user.name,
      details: "tokenVersion bumped",
    });

    return res.json({ message: "تم تسجيل الخروج من كل الأجهزة" });
  } catch (err) {
    console.error("Logout-all error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   GET /api/auth/activity
 * @desc    Get recent activity log for current user
 * @access  Private
 */
router.get("/activity", authMiddleware, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 30), 100));
    const logs = await AuditLog.find({ actorUser: req.user.id })
      .sort({ timestamp: -1 })
      .limit(limit)
      .select("timestamp action entityType entityName details ip");
    return res.json({ logs });
  } catch (err) {
    console.error("Activity error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   GET /api/auth/export
 * @desc    Export my account data (JSON)
 * @access  Private
 */
router.get("/export", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    let doctorProfile = null;
    if (user.role === "doctor") {
      doctorProfile = await DoctorProfile.findOne({ user: user._id });
    }

    const query = user.role === "doctor" && user.doctorProfile ? { doctorProfile: user.doctorProfile } : { user: user._id };
    const appointments = await Appointment.find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .select("doctorName specialty appointmentDate appointmentTime status bookingNumber doctorQueueNumber notes doctorNote doctorPrescriptions service createdAt");

    await audit(req, {
      actorUser: user._id,
      actorName: user.name,
      action: "EXPORT",
      entityType: "User",
      entityId: user._id,
      entityName: user.name,
      details: `appointments=${appointments.length}`,
    });

    return res.json({
      exportedAt: new Date().toISOString(),
      user,
      doctorProfile,
      appointments,
    });
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

/**
 * @route   DELETE /api/auth/me
 * @desc    Delete current user account (patient/doctor) and related data
 * @access  Private
 */
router.delete("/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ message: "كلمة المرور مطلوبة لتأكيد حذف الحساب" });
    }
    const match = await bcrypt.compare(String(password), user.password);
    if (!match) {
      return res.status(401).json({ message: "كلمة المرور غير صحيحة" });
    }

    // Resolve doctorProfile id if applicable
    let doctorProfileId = user.doctorProfile || null;
    if (user.role === "doctor" && !doctorProfileId) {
      const profile = await DoctorProfile.findOne({ user: userId }).select("_id");
      doctorProfileId = profile?._id || null;
    }

    const appointmentQuery =
      user.role === "doctor" && doctorProfileId
        ? { doctorProfile: doctorProfileId }
        : { user: userId };

    const appts = await Appointment.find(appointmentQuery).select("_id");
    const appointmentIds = appts.map((a) => a._id);

    // Remove chat messages related to this user or their appointments
    const messageOr = [{ senderId: userId }];
    if (appointmentIds.length) {
      messageOr.push({ appointmentId: { $in: appointmentIds } });
    }
    await Message.deleteMany({ $or: messageOr });

    // Remove blocks where the user is doctor or patient
    await Block.deleteMany({ $or: [{ doctor: userId }, { patient: userId }] });

    // Remove appointments
    await Appointment.deleteMany(appointmentQuery);

    // Doctor extras
    if (doctorProfileId) {
      await DoctorService.deleteMany({ doctorProfile: doctorProfileId });
      await DoctorProfile.deleteOne({ _id: doctorProfileId });
    }

    // Finally delete user
    await User.deleteOne({ _id: userId });

    await audit(req, {
      actorUser: userId,
      actorName: user.name,
      action: "DELETE_ACCOUNT",
      entityType: "User",
      entityId: userId,
      entityName: user.name,
      details: `role=${user.role}`,
    });

    return res.json({ message: "تم حذف الحساب بنجاح" });
  } catch (err) {
    console.error("Delete account error:", err);
    return res.status(500).json({ message: "خطأ في الخادم، حاول لاحقًا" });
  }
});

module.exports = router;
