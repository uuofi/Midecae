// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const DoctorProfile = require("../models/DoctorProfile");
const authMiddleware = require("../middleware/authMiddleware");
const sendSms = require("../utils/sendSms");

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

// دالة توليد توكن
const generateToken = (user) =>
  jwt.sign(
    { id: user._id, phone: user.phone, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );

/**
 * @route   POST /api/auth/register
 * @desc    Register user + send verification code
 * @access  Public
 */
router.post("/register", async (req, res) => {
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
router.post("/login", async (req, res) => {
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

    // تجاوز خطوة إرسال كود الدخول
    // Doctors must be approved + subscription active before they can login.
    if (user.role === "doctor") {
      const profile = await DoctorProfile.findOne({ user: user._id }).select(
        "status isAcceptingBookings isChatEnabled subscriptionEndsAt subscriptionGraceEndsAt"
      );
      if (!profile) {
        return res.status(403).json({ message: "Doctor profile not found" });
      }
      if (profile.status !== "active") {
        return res.status(403).json({ message: "بانتظار موافقة الادمن" });
      }
      // Require an active subscription.
      if (!profile.subscriptionEndsAt) {
        try {
          profile.status = "inactive";
          profile.isAcceptingBookings = false;
          profile.isChatEnabled = false;
          await profile.save();
        } catch (e) {}
        return res.status(403).json({ message: "لا يوجد اشتراك" });
      }
      const cutoff = profile.subscriptionGraceEndsAt || profile.subscriptionEndsAt;
      const cutoffMs = new Date(cutoff).getTime();
      if (!Number.isNaN(cutoffMs) && Date.now() > cutoffMs) {
        try {
          profile.status = "inactive";
          profile.isAcceptingBookings = false;
          profile.isChatEnabled = false;
          await profile.save();
        } catch (e) {}
        return res.status(403).json({ message: "الاشتراك منتهي" });
      }
    }

    const token = jwt.sign(
      { id: user._id, phone: user.phone, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );
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

module.exports = router;
