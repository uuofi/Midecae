// routes/appointments.js
const express = require("express");
const QRCode = require("qrcode");
const Appointment = require("../models/Appointment");
const DoctorProfile = require("../models/DoctorProfile");
const DoctorService = require("../models/DoctorService");
const Counter = require("../models/Counter");
const User = require("../models/User");
const Block = require("../models/Block");
const authMiddleware = require("../middleware/authMiddleware");

// 🔔 استيراد دالة الإشعارات
const { sendPushToUser } = require("./notifications");

// Ensure doctor display name carries the Arabic prefix "د. "
const ensureDoctorPrefix = (rawName = "") => {
  const name = String(rawName || "").trim();
  if (!name) return name;
  const prefixPattern = /^د\s*\.?\s*/i;
  const stripped = prefixPattern.test(name)
    ? name.replace(prefixPattern, "").trim()
    : name;
  return `د. ${stripped}`;
};

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

const isNumericBooking = (value) =>
  typeof value === "string" && /^[0-9]+$/.test(value.trim());

const ensureBookingNumber = async (appointment) => {
  if (!appointment) return appointment;
  if (
    !appointment.bookingNumber ||
    !isNumericBooking(appointment.bookingNumber)
  ) {
    appointment.bookingNumber = await getNextBookingNumber();
  }
  try {
    await appointment.save();
  } catch (err) {
    console.error("Booking number save error:", err?.message);
  }
  return appointment;
};

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

const ensureQrForAppointment = async (appointment, extraPayload = {}) => {
  if (!appointment) return appointment;
  await ensureBookingNumber(appointment);
  const patient = appointment.user
    ? await User.findById(appointment.user)
        .select("name phone age")
        .lean()
        .exec()
    : null;

  // normalize doctor name on the record and in QR payload
  const prefixedDoctor = ensureDoctorPrefix(appointment.doctorName);
  if (prefixedDoctor && prefixedDoctor !== appointment.doctorName) {
    appointment.doctorName = prefixedDoctor;
    try {
      await appointment.save();
    } catch (e) {
      console.error("Save doctorName prefix error:", e?.message);
    }
  }

  const systemBookingNumber = String(appointment.bookingNumber || "");
  const doctorQueueNumber =
    appointment.doctorQueueNumber === 0 ||
    typeof appointment.doctorQueueNumber === "number"
      ? Number(appointment.doctorQueueNumber)
      : null;
  const displayedBookingNumber = doctorQueueNumber
    ? String(doctorQueueNumber)
    : systemBookingNumber;

  // force regenerate if QR missing or doesn't include current booking number
  let needsRegenerate = true;
  if (appointment.qrCode && appointment.qrPayload) {
    try {
      const parsed = JSON.parse(appointment.qrPayload);
      const parsedBooking = String(parsed?.bookingNumber ?? "");
      const parsedSystem = String(
        parsed?.systemBookingNumber ?? parsed?.globalBookingNumber ?? ""
      );
      const parsedAge =
        parsed?.patientAge ??
        parsed?.age ??
        parsed?.userAge ??
        parsed?.patient_age;

      const expectedServiceName =
        typeof appointment?.service?.name === "string" && appointment.service.name.trim()
          ? appointment.service.name.trim()
          : "";
      const parsedServiceName = String(parsed?.serviceName ?? parsed?.service?.name ?? "").trim();
      if (
        parsedBooking === displayedBookingNumber &&
        (parsedSystem === "" ||
          parsedSystem === systemBookingNumber ||
          parsedBooking === systemBookingNumber) &&
        (patient?.age == null || String(parsedAge ?? "").trim() !== "") &&
        (!expectedServiceName || parsedServiceName === expectedServiceName)
      ) {
        needsRegenerate = false;
      }
    } catch (e) {
      needsRegenerate = true;
    }
  }

  if (!needsRegenerate) return appointment;

  const serviceName =
    typeof appointment?.service?.name === "string" && appointment.service.name.trim()
      ? appointment.service.name.trim()
      : null;
  const servicePriceRaw = appointment?.service?.price;
  const servicePrice =
    typeof servicePriceRaw === "number" ? servicePriceRaw : Number(servicePriceRaw);
  const serviceDurationRaw = appointment?.service?.durationMinutes;
  const serviceDurationMinutes =
    typeof serviceDurationRaw === "number" ? serviceDurationRaw : Number(serviceDurationRaw);
  const serviceId = appointment?.service?.serviceId
    ? appointment.service.serviceId.toString?.() || appointment.service.serviceId
    : null;

  const payload = {
    appointmentId: appointment._id,
    // What the doctor sees as the booking number (1,2,3... per doctor)
    bookingNumber: displayedBookingNumber,
    doctorQueueNumber,
    // Stable global booking number (monotonic across the system)
    systemBookingNumber,
    userId: appointment.user?.toString?.() || appointment.user,
    patientName: patient?.name,
    patientPhone: patient?.phone,
    patientAge: patient?.age,
    doctorName: appointment.doctorName,
    appointmentDate: appointment.appointmentDate,
    appointmentTime: appointment.appointmentTime,
    status: appointment.status,
    serviceName,
    servicePrice: Number.isFinite(servicePrice) ? servicePrice : null,
    serviceDurationMinutes: Number.isFinite(serviceDurationMinutes) ? serviceDurationMinutes : null,
    service: serviceName
      ? {
          serviceId,
          name: serviceName,
          price: Number.isFinite(servicePrice) ? servicePrice : null,
          durationMinutes: Number.isFinite(serviceDurationMinutes)
            ? serviceDurationMinutes
            : null,
        }
      : null,
    ...extraPayload,
  };

  const qrPayload = JSON.stringify(payload);
  try {
    const qrCode = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: "M",
    });
    appointment.qrCode = qrCode;
    appointment.qrPayload = qrPayload;
    await appointment.save();
  } catch (qrErr) {
    console.error("QR generate error:", qrErr?.message);
  }
  return appointment;
};

// Booking numbers are monotonic and must not be reused.
// We keep bookingNumber stable for a given appointment (even if cancelled/deleted).
// This helper only clears QR fields if you want to invalidate old QR codes.
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

const router = express.Router();

/**
 * @route POST /api/appointments
 * @desc  Book a new appointment
 * @access Private
 */
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      doctorName,
      doctorRole,
      specialty,
      specialtySlug,
      appointmentDate,
      appointmentTime,
      notes,
      doctorId,
      appointmentDateIso,
      appointmentTimeValue,
      serviceId,
    } = req.body;

    if (
      !doctorName ||
      !doctorRole ||
      !specialty ||
      !specialtySlug ||
      !appointmentDate ||
      !appointmentTime
    ) {
      return res
        .status(400)
        .json({ message: "All appointment fields are required" });
    }

    let linkedDoctor = null;
    if (doctorId) {
      linkedDoctor = await DoctorProfile.findById(doctorId);
      if (!linkedDoctor) {
        return res.status(404).json({ message: "Doctor not found" });
      }
    }

    // Resolve selected service (server-derived price + duration)
    let resolvedService = null;
    if (linkedDoctor && serviceId) {
      const svc = await DoctorService.findOne({
        _id: serviceId,
        doctorProfile: linkedDoctor._id,
        isActive: true,
      }).select("name price durationMinutes");
      if (!svc) {
        return res.status(400).json({ message: "الخدمة المختارة غير متاحة لدى هذا الطبيب" });
      }
      resolvedService = {
        serviceId: svc._id,
        name: svc.name,
        price: Number(svc.price) || 0,
        durationMinutes: Number(svc.durationMinutes) || 0,
      };
    } else if (linkedDoctor) {
      // Backwards-compatible default when no service is selected
      resolvedService = {
        serviceId: null,
        name: "",
        price: Number(linkedDoctor.consultationFee) || 0,
        durationMinutes: Number(linkedDoctor.schedule?.duration) || 0,
      };
    }

    const normalizedDateIso =
      typeof appointmentDateIso === "string" && appointmentDateIso
        ? appointmentDateIso
        : appointmentDate;
    const normalizedTimeValue =
      typeof appointmentTimeValue === "string" && appointmentTimeValue
        ? appointmentTimeValue
        : appointmentTime;

    if (linkedDoctor) {
      // Block booking if doctor blocked this patient
      const block = await Block.findOne({
        doctor: linkedDoctor.user,
        patient: req.user.id,
      });
      if (block?.blockBooking) {
        return res
          .status(403)
          .json({ message: "لا يمكنك الحجز لدى هذا الطبيب بسبب الحظر" });
      }

      // Block booking if doctor's subscription is expired
      try {
        const now = new Date();
        if (!linkedDoctor.subscriptionEndsAt) {
          return res.status(403).json({
            message: "لا يمكن الحجز لدى هذا الطبيب لأنه لا يملك اشتراكاً فعالاً",
          });
        }

        if (new Date(linkedDoctor.subscriptionEndsAt) < now) {
          // optional: allow within grace period
          if (
            !linkedDoctor.subscriptionGraceEndsAt ||
            new Date(linkedDoctor.subscriptionGraceEndsAt) < now
          ) {
            return res.status(403).json({
              message: "لا يمكن الحجز لدى هذا الطبيب لأن اشتراكه منتهي",
            });
          }
        }
      } catch (err) {
        console.error("Subscription check error:", err?.message);
      }

      if (!normalizedDateIso || !normalizedTimeValue) {
        return res
          .status(400)
          .json({ message: "يجب اختيار تاريخ ووقت صالحين من جدول الطبيب" });
      }
      const conflictFilter = {
        doctorProfile: linkedDoctor._id,
        status: { $in: ["pending", "confirmed"] },
      };
      conflictFilter.appointmentDateIso = normalizedDateIso;
      conflictFilter.appointmentTimeValue = normalizedTimeValue;

      const conflict = await Appointment.findOne(conflictFilter);
        // Debug: طباعة الفلتر ونتيجة البحث عن التعارض
        console.log("[حجز] فلتر التعارض:", conflictFilter);
        console.log("[حجز] نتيجة التعارض:", conflict);
      if (conflict) {
        // فقط إذا كان الحجز لنفس الوقت والطبيب
        if (
          conflict.doctorProfile.toString() === linkedDoctor._id.toString() &&
          conflict.appointmentDateIso === normalizedDateIso &&
          conflict.appointmentTimeValue === normalizedTimeValue
        ) {
          console.log("[حجز] تعارض في الموعد:", {
            doctorProfile: linkedDoctor._id,
            appointmentDateIso: normalizedDateIso,
            appointmentTimeValue: normalizedTimeValue,
            status: conflict.status,
            conflictId: conflict._id,
          });
          return res
            .status(409)
            .json({ message: "هذا الموعد محجوز مسبقاً، اختر وقتاً آخر", conflict });
        }
      }
    }

    const normalizedDoctorName = ensureDoctorPrefix(doctorName);

    // تحقق إذا كان لدى المستخدم حجز في نفس اليوم
    const userHasAppointment = await Appointment.findOne({
      user: req.user.id,
      doctorProfile: linkedDoctor ? linkedDoctor._id : null,
      appointmentDateIso: normalizedDateIso,
      status: { $in: ["pending", "confirmed"] },
    });
    if (userHasAppointment) {
      return res.status(409).json({
        message: "لا يمكنك الحجز أكثر من مرة في نفس اليوم مع نفس الطبيب",
      });
    }

    // حساب رقم الدور للطبيب حسب اليوم
    let doctorQueueNumber = null;
    if (linkedDoctor) {
      // استخدم عداد منفصل لكل طبيب ولكل يوم
      const counterKey = `doctorQueueNumber:${linkedDoctor._id}:${normalizedDateIso}`;
      const counter = await Counter.findOneAndUpdate(
        { key: counterKey },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      doctorQueueNumber = counter.seq;
    }
    const newAppointment = await Appointment.create({
      user: req.user.id,
      doctorName: normalizedDoctorName,
      doctorRole,
      specialty,
      specialtySlug,
      appointmentDate,
      appointmentDateIso: normalizedDateIso,
      appointmentTime,
      appointmentTimeValue: normalizedTimeValue,
      doctorProfile: linkedDoctor ? linkedDoctor._id : null,
      notes,
      bookingNumber: await getNextBookingNumber(),
      doctorQueueNumber: doctorQueueNumber,
      ...(resolvedService ? { service: resolvedService } : {}),
    });

    await ensureQrForAppointment(newAppointment);

    await newAppointment.populate({
      path: "doctorProfile",
      select:
        "avatarUrl location displayName specialtyLabel bio consultationFee secretaryPhone",
    });

    // 🔔 إرسال إشعار للدكتور عند حجز موعد جديد
    if (linkedDoctor && linkedDoctor.user) {
      try {
        const patient = await User.findById(req.user.id).select("name");
        const patientName = patient?.name || "مريض جديد";

        await sendPushToUser(linkedDoctor.user, {
          title: "حجز جديد",
          body: `تم حجز موعد جديد من ${patientName} بتاريخ ${appointmentDate} في ${appointmentTime}`,
          data: {
            type: "appointment_created",
            appointmentId: String(newAppointment._id),
            role: "doctor",
          },
        });
      } catch (pushErr) {
        console.error("Error sending push to doctor:", pushErr?.message);
      }
    }

    return res.status(201).json({
      message: "Appointment booked",
      appointment: newAppointment,
    });
  } catch (err) {
    console.error("[حجز] Booking error:", err);
    if (err.code === 11000) {
      return res
        .status(409)
        .json({ message: "هذا الموعد محجوز مسبقاً، اختر وقتاً آخر", error: err });
    }
    return res.status(500).json({ message: "Server error", error: err });
  }
});

/**
 * @route GET /api/appointments
 * @desc  Get current user's bookings
 * @access Private
 */
router.get("/", authMiddleware, async (req, res) => {
  try {
    const appointments = await Appointment.find({ user: req.user.id })
      .select("-qrCode -qrPayload")
      .populate({
        path: "doctorProfile",
        select:
          "avatarUrl location locationLat locationLng displayName specialtyLabel bio consultationFee secretaryPhone",
      })
      .sort({ createdAt: -1 });

    // Ensure doctor names are consistently prefixed for legacy rows
    appointments.forEach((appt) => {
      const prefixed = ensureDoctorPrefix(appt.doctorName);
      if (prefixed !== appt.doctorName) {
        appt.doctorName = prefixed;
      }
      if (appt.doctorProfile && appt.doctorProfile.displayName) {
        const displayPref = ensureDoctorPrefix(appt.doctorProfile.displayName);
        if (displayPref !== appt.doctorProfile.displayName) {
          appt.doctorProfile.displayName = displayPref;
        }
      }
    });

    // backfill booking number for legacy bookings (keep this lightweight)
    await Promise.all(
      appointments
        .filter(
          (appt) =>
            !appt.bookingNumber ||
            (typeof appt.bookingNumber === "string" &&
              !isNumericBooking(appt.bookingNumber))
        )
        .map((appt) => ensureBookingNumber(appt))
    );

    // For patient-facing responses, show the booking number the doctor sees
    // (per-doctor queue number) when available. Do not persist this override;
    // only modify the returned objects so the mobile app displays the same
    // number that the doctor sees in their queue.
    appointments.forEach((appt) => {
      const doctorQueueNumber =
        appt.doctorQueueNumber === 0 ||
        typeof appt.doctorQueueNumber === "number"
          ? Number(appt.doctorQueueNumber)
          : null;
      const systemBookingNumber = String(appt.bookingNumber || "");
      const displayedBookingNumber = doctorQueueNumber
        ? String(doctorQueueNumber)
        : systemBookingNumber;

      // override in-memory only
      appt.bookingNumber = displayedBookingNumber;
    });

    // إرجاع الباركود وتفاصيله مع كل موعد
    return res.json({ appointments });
  } catch (err) {
    console.error("Fetch appointments error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * @route GET /api/appointments/:id
 * @desc  Get one appointment details (includes QR)
 * @access Private
 */
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    if (!appointmentId || !appointmentId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "Invalid appointment id" });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const isPatient = appointment.user?.toString?.() === req.user.id;
    let isDoctor = false;
    if (!isPatient && appointment.doctorProfile) {
      const dp = await DoctorProfile.findById(appointment.doctorProfile)
        .select("user")
        .lean();
      isDoctor = dp?.user?.toString?.() === req.user.id;
    }

    if (!isPatient && !isDoctor) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await appointment.populate({
      path: "doctorProfile",
      select:
        "avatarUrl location locationLat locationLng displayName specialtyLabel bio consultationFee secretaryPhone",
    });

    // Generate QR only when requested on details.
    await ensureQrForAppointment(appointment);

    return res.json({ appointment });
  } catch (err) {
    console.error("Fetch appointment details error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * @route   PATCH /api/appointments/:id/cancel
 * @desc    Cancel a booking
 * @access  Private
 */
router.patch("/:id/cancel", authMiddleware, async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (appointment.user.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    appointment.status = "cancelled";
    await appointment.save();

    //            : notify doctor when patient cancels
    try {
      if (appointment.doctorProfile) {
        const doctorProfile = await DoctorProfile.findById(appointment.doctorProfile)
          .select("user displayName")
          .lean();
        if (doctorProfile?.user) {
          const patient = await User.findById(req.user.id).select("name").lean();
          const patientName = patient?.name || "    ";
          const doctorName = ensureDoctorPrefix(doctorProfile.displayName);
          const apptDate = appointment.appointmentDate || appointment.appointmentDateIso || "";
          const apptTime = appointment.appointmentTime || appointment.appointmentTimeValue || "";

          await sendPushToUser(doctorProfile.user, {
            title: "تم إلغاء حجز",
            body: `قام ${patientName} بإلغاء الحجز${doctorName ? ` لدى ${doctorName}` : ""}${apptDate ? ` بتاريخ ${apptDate}` : ""}${apptTime ? ` في ${apptTime}` : ""}`,
            data: {
              type: "appointment_cancelled",
              appointmentId: String(appointment._id),
              role: "doctor",
            },
          });
        }
      }
    } catch (pushErr) {
      console.error("Push to doctor (patient cancel) error:", pushErr?.message);
    }

    await releaseBookingNumber(appointment);

    return res.json({ appointment });
  } catch (err) {
    console.error("Cancel appointment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
