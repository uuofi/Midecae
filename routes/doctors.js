const express = require("express");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const authMiddleware = require("../middleware/authMiddleware");
const DoctorProfile = require("../models/DoctorProfile");
const Appointment = require("../models/Appointment");
const Counter = require("../models/Counter");
const User = require("../models/User");

// Ensure doctor names are unified with the Arabic prefix "د. "
const ensureDoctorPrefix = (rawName = "") => {
  const name = String(rawName || "").trim();
  if (!name) return name;
  const prefixPattern = /^د\s*\.?\s*/i;
  const stripped = prefixPattern.test(name) ? name.replace(prefixPattern, "").trim() : name;
  return `د. ${stripped}`;
};

const normalizePhone = (phone) => (phone || "").replace(/\s|-/g, "").trim();
const isValidPhone = (phone) => /^\+?\d{9,15}$/.test(normalizePhone(phone));
const generateStrongPassword = () => {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "0123456789";
  const all = `${upper}${lower}${digits}`;
  const pick = (source) => source[Math.floor(Math.random() * source.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < 12) chars.push(pick(all));
  return chars.sort(() => 0.5 - Math.random()).join("");
};

const findOrCreatePatient = async ({ name, phone }) => {
  if (!name || !phone) {
    throw new Error("اسم ورقم المراجع مطلوبان");
  }
  const normalizedPhone = normalizePhone(phone);
  if (!isValidPhone(normalizedPhone)) {
    throw new Error("صيغة رقم المراجع غير صحيحة");
  }

  let createdPassword = null;
  let patient = await User.findOne({ phone: normalizedPhone, role: "patient" });

  if (!patient) {
    createdPassword = generateStrongPassword();
    const hashed = await bcrypt.hash(createdPassword, 12);
    patient = await User.create({
      name: name.trim(),
      phone: normalizedPhone,
      password: hashed,
      role: "patient",
      phoneVerified: true,
    });
  } else if (!patient.name && name) {
    patient.name = name.trim();
    await patient.save();
  }

  return { patient, createdPassword };
};

const DEFAULT_SCHEDULE = {
  activeDays: ["mon", "tue", "wed", "thu", "fri"],
  startTime: "09:00",
  endTime: "17:00",
  breakEnabled: true,
  breakFrom: "13:00",
  breakTo: "14:00",
  duration: 20,
  allowOnline: true,
  emergency: false,
};

const VALID_DAY_KEYS = new Set([
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
]);

const router = express.Router();

const getNextBookingNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    { key: "bookingNumber" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return String(counter.seq);
};

const getNextDoctorQueueNumber = async (doctorProfileId) => {
  if (!doctorProfileId) return null;
  const key = `doctorQueueNumber:${doctorProfileId}`;
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return Number(counter.seq);
};

const ensureDoctorQueueBackfill = async (doctorProfileId) => {
  if (!doctorProfileId) return;

  const total = await Appointment.countDocuments({ doctorProfile: doctorProfileId });
  if (!total) return;

  const assigned = await Appointment.countDocuments({
    doctorProfile: doctorProfileId,
    doctorQueueNumber: { $type: "number" },
  });

  const maxRow = await Appointment.aggregate([
    { $match: { doctorProfile: doctorProfileId, doctorQueueNumber: { $type: "number" } } },
    { $group: { _id: null, max: { $max: "$doctorQueueNumber" }, min: { $min: "$doctorQueueNumber" } } },
  ]);
  const max = Number(maxRow?.[0]?.max ?? 0);
  const min = Number(maxRow?.[0]?.min ?? 0);

  // We want a tight sequence 1..total for THIS doctor.
  const needsRenumber = assigned !== total || max !== total || min !== 1;
  if (!needsRenumber) return;

  const appointments = await Appointment.find({ doctorProfile: doctorProfileId }).sort({ createdAt: 1 });
  let seq = 0;
  for (const appt of appointments) {
    seq += 1;
    if (appt.doctorQueueNumber !== seq) {
      appt.doctorQueueNumber = seq;
      // Clear QR so it gets regenerated with the new number.
      appt.qrCode = "";
      appt.qrPayload = "";
      await appt.save();
    }
  }

  await Counter.findOneAndUpdate(
    { key: `doctorQueueNumber:${doctorProfileId}` },
    { $set: { seq } },
    { upsert: true, setDefaultsOnInsert: true }
  );
};

const isNumericBooking = (value) => typeof value === "string" && /^[0-9]+$/.test(value.trim());

const attachDoctorIndex = (appointments = []) =>
  appointments.map((appt, idx) => {
    const obj = typeof appt?.toObject === "function" ? appt.toObject() : appt;
    return { ...obj, doctorIndex: idx + 1 };
  });

const renumberAllAppointments = async () => {
  const appointments = await Appointment.find({}).sort({ createdAt: 1 });
  let seq = 0;

  for (const appt of appointments) {
    seq += 1;
    if (!appt.bookingNumber || Number(appt.bookingNumber) !== seq) {
      appt.bookingNumber = String(seq);
      await appt.save();
    }
  }

  await Counter.findOneAndUpdate(
    { key: "bookingNumber" },
    { $set: { seq } },
    { upsert: true }
  );

  return seq;
};

const syncBookingCounterToMax = async () => {
  // find highest purely-numeric booking number
  const latest = await Appointment.aggregate([
    { $match: { bookingNumber: { $regex: "^[0-9]+$" } } },
    { $addFields: { bnNum: { $toInt: "$bookingNumber" } } },
    { $sort: { bnNum: -1 } },
    { $limit: 1 },
  ]);

  const maxValue = Array.isArray(latest) && latest[0]?.bnNum ? Number(latest[0].bnNum) : 0;

  await Counter.findOneAndUpdate(
    { key: "bookingNumber" },
    { $set: { seq: maxValue } },
    { upsert: true }
  );
};

const ensureBookingNumber = async (appointment) => {
  if (!appointment) return appointment;
  if (!appointment.bookingNumber || !isNumericBooking(appointment.bookingNumber)) {
    appointment.bookingNumber = await getNextBookingNumber();
  }
  try {
    await appointment.save();
  } catch (err) {
    console.error("Booking number save error:", err?.message);
  }
  return appointment;
};

// Booking numbers are monotonic and must not be reused.
// Keep bookingNumber stable for a given appointment; only clear QR fields.
const releaseBookingNumber = async (appointment) => {
  if (!appointment) return;

  appointment.qrCode = "";
  appointment.qrPayload = "";
  try {
    await appointment.save();
  } catch (err) {
    console.error("Release booking number save error:", err?.message);
  }
};

const ensureQrForAppointment = async (appointment, extraPayload = {}) => {
  if (!appointment) return appointment;
  await ensureBookingNumber(appointment);

  const patientId = appointment.user?._id || appointment.user;
  const patient = patientId
    ? await User.findById(patientId).select("name phone age").lean().exec()
    : null;

  const systemBookingNumber = String(appointment.bookingNumber || "");
  const doctorQueueNumber =
    appointment.doctorQueueNumber === 0 || typeof appointment.doctorQueueNumber === "number"
      ? Number(appointment.doctorQueueNumber)
      : null;
  const displayedBookingNumber = doctorQueueNumber ? String(doctorQueueNumber) : systemBookingNumber;

  let needsRegenerate = true;
  if (appointment.qrCode && appointment.qrPayload) {
    try {
      const parsed = JSON.parse(appointment.qrPayload);
      const parsedBooking = String(parsed?.bookingNumber ?? "");
      const parsedSystem = String(parsed?.systemBookingNumber ?? parsed?.globalBookingNumber ?? "");
      const parsedAge = parsed?.patientAge ?? parsed?.age ?? parsed?.userAge ?? parsed?.patient_age;
      if (
        parsedBooking === displayedBookingNumber &&
        (parsedSystem === "" || parsedSystem === systemBookingNumber || parsedBooking === systemBookingNumber) &&
        (patient?.age == null || String(parsedAge ?? "").trim() !== "")
      ) {
        needsRegenerate = false;
      }
    } catch (e) {
      needsRegenerate = true;
    }
  }

  if (!needsRegenerate) return appointment;

  const payload = {
    appointmentId: appointment._id,
    // What the doctor sees as the booking number (1,2,3... per doctor)
    bookingNumber: displayedBookingNumber,
    doctorQueueNumber,
    // Stable global booking number (monotonic across the system)
    systemBookingNumber,
    userId: patientId,
    patientName: patient?.name,
    patientPhone: patient?.phone,
    patientAge: patient?.age,
    doctorName: appointment.doctorName,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    status: appointment.status,
    ...extraPayload,
  };

  const qrPayload = JSON.stringify(payload);
  try {
    const qrCode = await QRCode.toDataURL(qrPayload, { errorCorrectionLevel: "M" });
    appointment.qrCode = qrCode;
    appointment.qrPayload = qrPayload;
    await appointment.save();
  } catch (qrErr) {
    console.error("QR generate error:", qrErr?.message);
  }
  return appointment;
};

router.get("/", async (req, res) => {
  try {
    const now = new Date();
    const doctors = await DoctorProfile.find({
      status: "active",
      isAcceptingBookings: true,
      $or: [{ subscriptionEndsAt: { $gt: now } }, { subscriptionEndsAt: null }],
    }).populate("user", "name email age");

    doctors.forEach((doc) => {
      if (doc.displayName) {
        const prefixed = ensureDoctorPrefix(doc.displayName);
        if (prefixed !== doc.displayName) doc.displayName = prefixed;
      }
      if (doc.user?.name) {
        const prefUser = ensureDoctorPrefix(doc.user.name);
        if (prefUser !== doc.user.name) doc.user.name = prefUser;
      }
    });
    return res.json({
      doctors,
    });
  } catch (err) {
    console.error("Fetch doctors error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    if (profile.displayName) {
      const pref = ensureDoctorPrefix(profile.displayName);
      if (pref !== profile.displayName) profile.displayName = pref;
    }
    if (user.name) {
      const prefUser = ensureDoctorPrefix(user.name);
      if (prefUser !== user.name) user.name = prefUser;
    }

    const specialtySlug = profile.specialtySlug;
    const appointmentFilter = {
      $or: [
        { doctorProfile: profile._id },
        ...(specialtySlug ? [{ specialtySlug }] : []),
      ],
    };

    await ensureDoctorQueueBackfill(profile._id);

    const appointments = await Appointment.find(appointmentFilter)
      .sort({ createdAt: -1 })
      .limit(20);

    const appointmentsWithIndex = attachDoctorIndex(appointments);

    const pending = appointments.filter((a) => a.status === "pending").length;
    const confirmed = appointments.filter((a) => a.status === "confirmed").length;

    return res.json({
      doctor: profile,
      stats: {
        pending,
        confirmed,
        total: appointments.length,
      },
      appointments: appointmentsWithIndex,
    });
  } catch (err) {
    console.error("Doctor me error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/appointments", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const specialtySlug = profile.specialtySlug;
    const appointmentFilter = {
      $or: [
        { doctorProfile: profile._id },
        ...(specialtySlug ? [{ specialtySlug }] : []),
      ],
    };

    await ensureDoctorQueueBackfill(profile._id);

    const appointments = await Appointment.find(appointmentFilter)
      .populate("user", "name email phone age")
      .sort({ doctorQueueNumber: 1, createdAt: 1 });

    appointments.forEach((appt) => {
      const prefixed = ensureDoctorPrefix(appt.doctorName);
      if (prefixed !== appt.doctorName) appt.doctorName = prefixed;
    });

    await Promise.all(appointments.map((appt) => ensureQrForAppointment(appt)));

    const appointmentsWithIndex = attachDoctorIndex(appointments);

    return res.json({
      appointments: appointmentsWithIndex,
    });
  } catch (err) {
    console.error("Doctor appointments error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Allow doctors to create a booking for a patient from their side
router.post("/appointments/manual", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const {
      patientName,
      patientPhone,
      appointmentDate,
      appointmentTime,
      appointmentDateIso,
      appointmentTimeValue,
      notes,
      status = "confirmed",
    } = req.body;

    if (!patientName || !patientPhone || !appointmentDate || !appointmentTime) {
      return res.status(400).json({ message: "بيانات المراجع والموعد مطلوبة" });
    }

    const { patient, createdPassword } = await findOrCreatePatient({
      name: patientName,
      phone: patientPhone,
    });

    const normalizedDateIso =
      typeof appointmentDateIso === "string" && appointmentDateIso
        ? appointmentDateIso
        : appointmentDate;
    const normalizedTimeValue =
      typeof appointmentTimeValue === "string" && appointmentTimeValue
        ? appointmentTimeValue
        : appointmentTime;

    const conflict = await Appointment.findOne({
      doctorProfile: profile._id,
      status: { $in: ["pending", "confirmed"] },
      appointmentDateIso: normalizedDateIso,
      appointmentTimeValue: normalizedTimeValue,
    });

    if (conflict) {
      return res
        .status(409)
        .json({ message: "هذا الموعد محجوز مسبقاً، اختر وقتاً آخر" });
    }

    const normalizedDoctorName = ensureDoctorPrefix(profile.displayName || user.name);
    const doctorRole = profile.specialtyLabel || profile.specialty || "طبيب";
    const specialty = profile.specialtyLabel || profile.specialty || "عيادة";
    const specialtySlug = profile.specialtySlug || profile.specialty || "manual";
    const safeStatus = ["pending", "confirmed"].includes(status)
      ? status
      : "confirmed";

    const appointment = await Appointment.create({
      user: patient._id,
      doctorName: normalizedDoctorName,
      doctorRole,
      specialty,
      specialtySlug,
      appointmentDate,
      appointmentDateIso: normalizedDateIso,
      appointmentTime,
      appointmentTimeValue: normalizedTimeValue,
      doctorProfile: profile._id,
      notes: typeof notes === "string" ? notes : "",
      createdByDoctor: true,
      status: safeStatus,
      bookingNumber: await getNextBookingNumber(),
      doctorQueueNumber: await getNextDoctorQueueNumber(profile._id),
    });

    await ensureQrForAppointment(appointment, {
      patientName: patient.name,
      patientPhone: patient.phone,
      patientAge: patient.age,
    });

    const populatedAppointment = await Appointment.findById(appointment._id).populate(
      "user",
      "name email phone age"
    );

    return res.status(201).json({
      appointment: populatedAppointment,
      tempPassword: createdPassword,
    });
  } catch (err) {
    console.error("Manual appointment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/appointments/:id/accept", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      status: "pending",
      specialtySlug: profile.specialtySlug,
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found or not in your specialty" });
    }

    if (appointment.doctorProfile && appointment.doctorProfile.toString() !== profile._id.toString()) {
      return res.status(409).json({ message: "Appointment already assigned" });
    }

    // Prevent double-booking same slot for this doctor
    if (appointment.appointmentDateIso && appointment.appointmentTimeValue) {
      const conflict = await Appointment.findOne({
        _id: { $ne: appointment._id },
        doctorProfile: profile._id,
        status: { $in: ["pending", "confirmed"] },
        appointmentDateIso: appointment.appointmentDateIso,
        appointmentTimeValue: appointment.appointmentTimeValue,
      });
      if (conflict) {
        return res
          .status(409)
          .json({ message: "هذا الوقت محجوز لطبيبك بالفعل، اختر موعداً آخر" });
      }
    }

    appointment.status = "confirmed";
    appointment.doctorProfile = profile._id;
    await appointment.save();

    // ensure booking number is set (accepting could come from specialty queue)
    await ensureBookingNumber(appointment);

    const populatedAppointment = await Appointment.findById(appointment._id).populate(
      "user",
      "name email phone age"
    );
    if (populatedAppointment && populatedAppointment.doctorName) {
      const prefixed = ensureDoctorPrefix(populatedAppointment.doctorName);
      if (prefixed !== populatedAppointment.doctorName) {
        populatedAppointment.doctorName = prefixed;
      }
    }
    await ensureQrForAppointment(populatedAppointment);

    return res.json({ appointment: populatedAppointment });
  } catch (err) {
    console.error("Accept appointment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/appointments/:id/reject", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      status: "pending",
      $or: [
        { doctorProfile: profile._id },
        ...(profile.specialtySlug ? [{ specialtySlug: profile.specialtySlug }] : []),
      ],
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found or already handled" });
    }

    appointment.status = "cancelled";
    await appointment.save();

    await releaseBookingNumber(appointment);

    return res.json({ appointment });
  } catch (err) {
    console.error("Reject appointment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/appointments/:id/cancel", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      status: { $in: ["pending", "confirmed"] },
      $or: [
        { doctorProfile: profile._id },
        ...(profile.specialtySlug ? [{ specialtySlug: profile.specialtySlug }] : []),
      ],
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found or already handled" });
    }

    appointment.status = "cancelled";
    await appointment.save();

    await releaseBookingNumber(appointment);

    const populatedAppointment = await Appointment.findById(appointment._id).populate(
      "user",
      "name email phone age"
    );
    await ensureQrForAppointment(populatedAppointment);

    return res.json({ appointment: populatedAppointment });
  } catch (err) {
    console.error("Cancel appointment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.delete("/appointments/:id", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      $or: [
        { doctorProfile: profile._id },
        ...(profile.specialtySlug ? [{ specialtySlug: profile.specialtySlug }] : []),
      ],
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    await releaseBookingNumber(appointment);
    await appointment.deleteOne();

    return res.json({ message: "Appointment deleted" });
  } catch (err) {
    console.error("Delete appointment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Save doctor note and prescriptions on an appointment
router.patch("/appointments/:id/note", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      $or: [
        { doctorProfile: profile._id },
        ...(profile.specialtySlug ? [{ specialtySlug: profile.specialtySlug }] : []),
      ],
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const doctorNote = typeof req.body.note === "string" ? req.body.note.trim() : appointment.doctorNote;
    const doctorPrescriptions = Array.isArray(req.body.prescriptions)
      ? req.body.prescriptions.filter((p) => typeof p === "string" && p.trim() !== "")
      : appointment.doctorPrescriptions || [];

    appointment.doctorNote = doctorNote;
    appointment.doctorPrescriptions = doctorPrescriptions;
    await appointment.save();

    const populatedAppointment = await Appointment.findById(appointment._id).populate(
      "user",
      "name email phone age"
    );

    return res.json({ appointment: populatedAppointment });
  } catch (err) {
    console.error("Save doctor note error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/me/schedule", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const requestedDays = Array.isArray(req.body.activeDays)
      ? req.body.activeDays.filter((day) => VALID_DAY_KEYS.has(day))
      : profile.schedule?.activeDays || DEFAULT_SCHEDULE.activeDays;

    const parsedDuration = Number(req.body.duration);
    const normalizedDuration =
      Number.isFinite(parsedDuration) && parsedDuration > 0
        ? parsedDuration
        : profile.schedule?.duration || DEFAULT_SCHEDULE.duration;

    const scheduleUpdate = {
      activeDays: requestedDays.length
        ? requestedDays
        : profile.schedule?.activeDays || DEFAULT_SCHEDULE.activeDays,
      startTime:
        typeof req.body.startTime === "string"
          ? req.body.startTime
          : profile.schedule?.startTime || DEFAULT_SCHEDULE.startTime,
      endTime:
        typeof req.body.endTime === "string"
          ? req.body.endTime
          : profile.schedule?.endTime || DEFAULT_SCHEDULE.endTime,
      breakEnabled:
        typeof req.body.breakEnabled === "boolean"
          ? req.body.breakEnabled
          : profile.schedule?.breakEnabled || DEFAULT_SCHEDULE.breakEnabled,
      breakFrom:
        typeof req.body.breakFrom === "string"
          ? req.body.breakFrom
          : profile.schedule?.breakFrom || DEFAULT_SCHEDULE.breakFrom,
      breakTo:
        typeof req.body.breakTo === "string"
          ? req.body.breakTo
          : profile.schedule?.breakTo || DEFAULT_SCHEDULE.breakTo,
      duration: normalizedDuration,
      allowOnline:
        typeof req.body.allowOnline === "boolean"
          ? req.body.allowOnline
          : profile.schedule?.allowOnline || DEFAULT_SCHEDULE.allowOnline,
      emergency:
        typeof req.body.emergency === "boolean"
          ? req.body.emergency
          : profile.schedule?.emergency || DEFAULT_SCHEDULE.emergency,
    };

    profile.schedule = {
      ...profile.schedule,
      ...scheduleUpdate,
    };
    await profile.save();

    return res.json({ schedule: profile.schedule });
  } catch (err) {
    console.error("Update schedule error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/me/profile", authMiddleware, async (req, res) => {
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

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No profile data provided" });
    }

    Object.assign(profile, updates);
    await profile.save();

    return res.json({ doctor: profile });
  } catch (err) {
    console.error("Update profile error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/me/activate", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    profile.status = "active";
    profile.isAcceptingBookings = true;
    await profile.save();

    return res.json({ doctor: profile });
  } catch (err) {
    console.error("Activate doctor error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Public: get doctor profile by id (includes schedule)
router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await DoctorProfile.findById(id).populate("user", "name");
    if (!doc) return res.status(404).json({ message: "Doctor not found" });

    return res.json({
      doctor: {
        _id: doc._id,
        name: doc.displayName || (doc.user && doc.user.name) || "",
        role: doc.specialtyLabel || doc.specialty || "",
        specialty: doc.specialtyLabel || doc.specialty || "",
        specialtySlug: doc.specialtySlug || "",
        avatarUrl: doc.avatarUrl || "",
        schedule: doc.schedule || {},
      },
    });
  } catch (err) {
    console.error("Get doctor by id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
