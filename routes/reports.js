const express = require("express");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const authMiddleware = require("../middleware/authMiddleware");
const DoctorProfile = require("../models/DoctorProfile");
const User = require("../models/User");
const mongoose = require("mongoose");
const Appointment = require("../models/Appointment");

const router = express.Router();

const normalizeDateIso = (value) => {
  const todayIso = () => new Date().toISOString().split("T")[0];
  if (!value) return todayIso();

  const raw = String(value).trim();

  // Strict YYYY-MM-DD parsing to avoid timezone shifts
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map((n) => Number(n));
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(dt.getTime())) return todayIso();
    const iso = dt.toISOString().split("T")[0];
    // Guard against invalid dates like 2024-02-30
    return iso === raw ? raw : todayIso();
  }

  const candidate = new Date(raw);
  if (Number.isNaN(candidate.getTime())) return todayIso();
  // For full date-times, normalize to ISO date (UTC)
  return candidate.toISOString().split("T")[0];
};

const normalizeMonthIso = (value) => {
  if (!value) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const raw = String(value).trim();
  // allow YYYY-MM or any date string
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
};

const getMonthRange = (monthIso) => {
  const [y, m] = String(monthIso).split("-");
  const year = Number(y);
  const month = Number(m);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    startIso: start.toISOString().split("T")[0],
    endIso: end.toISOString().split("T")[0],
  };
};

const statusLabels = {
  pending: "قيد التأكيد",
  confirmed: "مقبولة",
  completed: "مكتملة",
  cancelled: "ملغاة",
};

const toMoney = (value) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const buildExcelWorkbook = ({ title, doctorName, periodLabel, rows, totals, totalsLabels }) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MediCare";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Report", {
    views: [{ rightToLeft: true }],
    pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.addRow([title]);
  sheet.addRow([`اسم الطبيب: ${doctorName || "-"}`]);
  sheet.addRow([periodLabel]);
  sheet.addRow([]);

  const headerRow = sheet.addRow([
    "اسم المريض",
    "العمر",
    "الحالة المرضية",
    "سعر الكشفية",
    "تاريخ الحجز",
    "وقت الحجز",
    "الحالة",
  ]);
  headerRow.font = { bold: true };

  rows.forEach((r) => {
    sheet.addRow([
      r.patientName || "مراجع",
      r.patientAge ?? "-",
      r.condition || "-",
      r.price,
      r.date || "-",
      r.time || "-",
      statusLabels[r.status] || r.status || "-",
    ]);
  });

  sheet.addRow([]);

  const confirmedCountLabel = totalsLabels?.confirmedCount || "عدد الحجوزات المؤكدة";
  const pendingCountLabel = totalsLabels?.pendingCount || "عدد الحجوزات غير مؤكدة";
  const cancelledCountLabel = totalsLabels?.cancelledCount || "عدد الحجوزات الملغاة";
  const moneyLabel = totalsLabels?.money || "مجموع الفلوس (المؤكدة)";

  const totalsRow1 = sheet.addRow(["", "", "", "", "", confirmedCountLabel, totals.confirmedCount ?? 0]);
  totalsRow1.font = { bold: true };
  const totalsRow2 = sheet.addRow(["", "", "", "", "", pendingCountLabel, totals.pendingCount ?? 0]);
  totalsRow2.font = { bold: true };
  const totalsRow3 = sheet.addRow(["", "", "", "", "", cancelledCountLabel, totals.cancelledCount ?? 0]);
  totalsRow3.font = { bold: true };
  const totalsRow4 = sheet.addRow(["", "", "", "", "", moneyLabel, totals.totalMoney ?? 0]);
  totalsRow4.font = { bold: true };

  // Basic column widths
  sheet.columns = [
    { width: 22 },
    { width: 10 },
    { width: 35 },
    { width: 14 },
    { width: 16 },
    { width: 12 },
    { width: 14 },
  ];

  return workbook;
};

const amiriRegularPath = require.resolve(
  "@fontsource/amiri/files/amiri-arabic-400-normal.woff"
);
const amiriBoldPath = require.resolve("@fontsource/amiri/files/amiri-arabic-700-normal.woff");

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

router.get("/doctors-by-specialty", async (req, res) => {
  try {
    const doctors = await DoctorProfile.find()
      .populate("user", "name email age phone")
      .lean();

    const grouped = doctors.reduce((acc, profile) => {
      const slug = profile.specialtySlug || profile.specialty || "unassigned";
      const label = profile.specialtyLabel || profile.specialty || "غير محدد";

      if (!acc[slug]) {
        acc[slug] = {
          specialtySlug: slug,
          specialtyLabel: label,
          doctors: [],
        };
      }

      acc[slug].doctors.push({
        id: profile._id,
        displayName: profile.displayName,
        licenseNumber: profile.licenseNumber,
        status: profile.status,
        isAcceptingBookings: profile.isAcceptingBookings,
        email: profile.user?.email || "",
        phone: profile.user?.phone || "",
        age: profile.user?.age || null,
        // Keep legacy field name used by older mobile builds.
        // Prefer the doctor's account phone; fallback to the stored secretary phone.
        secretaryPhone: profile.user?.phone || profile.secretaryPhone || "",
        secretaryPhoneRaw: profile.secretaryPhone || "",
        contactPhone: profile.user?.phone || profile.secretaryPhone || "",
        avatarUrl: profile.avatarUrl,
        location: profile.location,
        locationLat: typeof profile.locationLat === "number" ? profile.locationLat : null,
        locationLng: typeof profile.locationLng === "number" ? profile.locationLng : null,
        role: profile.specialtyLabel || "طبيب",
        schedule: profile.schedule || DEFAULT_SCHEDULE,
        bio: profile.bio,
        certification: profile.certification,
        cv: profile.cv,
        consultationFee: profile.consultationFee,
        specialty: profile.specialty,
        specialtyLabel: profile.specialtyLabel,
      });

      return acc;
    }, {});

    return res.json({ bySpecialty: Object.values(grouped) });
  } catch (err) {
    console.error("Doctors by specialty error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/doctors/:id/booked-slots", async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ message: "صيغة المعرف غير صحيحة" });
    }

    const doctor = await DoctorProfile.findById(doctorId);
    if (!doctor) {
      return res.status(404).json({ message: "الطبيب غير موجود" });
    }

    const defaultDays = 14;
    const requestedDays = Number(req.query.days);
    const lookahead = Number.isFinite(requestedDays) && requestedDays > 0
      ? Math.min(requestedDays, 30)
      : defaultDays;

    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + lookahead);

    const startIso = startDate.toISOString().split("T")[0];
    const endIso = endDate.toISOString().split("T")[0];

    const appointments = await Appointment.find({
      doctorProfile: doctor._id,
      status: { $in: ["pending", "confirmed"] },
      appointmentDateIso: { $gte: startIso, $lt: endIso },
    }).select("appointmentDateIso appointmentTimeValue").lean();

    const blockedSlots = appointments.reduce((acc, appointment) => {
      const dateKey = appointment.appointmentDateIso;
      const timeValue = appointment.appointmentTimeValue;
      if (!dateKey || !timeValue) {
        return acc;
      }
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      if (!acc[dateKey].includes(timeValue)) {
        acc[dateKey].push(timeValue);
      }
      return acc;
    }, {});

    return res.json({ blockedSlots });
  } catch (err) {
    console.error("Booked slots error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/doctors/me/daily-bookings/link", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const dateIso = normalizeDateIso(req.body?.date || req.query?.date);
    const payload = {
      type: "daily-report",
      userId: user._id.toString(),
      doctorProfileId: profile._id.toString(),
      date: dateIso,
    };
    const downloadToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "5m",
    });
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const downloadUrl = `${baseUrl}/api/reports/download/daily?token=${encodeURIComponent(
      downloadToken
    )}`;

    return res.json({ downloadUrl, expiresIn: 300, date: dateIso });
  } catch (err) {
    console.error("Daily report link error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/download/daily", async (req, res) => {
  const { token } = req.query || {};
  if (!token) {
    return res.status(400).json({ message: "Download token is required" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    console.error("Report download token error:", err.message);
    return res.status(401).json({ message: "Invalid or expired download token" });
  }

  if (payload.type !== "daily-report") {
    return res.status(400).json({ message: "Invalid report token" });
  }

  const profile = await DoctorProfile.findById(payload.doctorProfileId);
  if (!profile || profile.user.toString() !== payload.userId) {
    return res.status(403).json({ message: "Unauthorized report download" });
  }

  const doctorUser = await User.findById(payload.userId).select("name email");

  const targetDate = normalizeDateIso(payload.date);
  const appointments = await Appointment.find({
    doctorProfile: profile._id,
    appointmentDateIso: targetDate,
    status: { $in: ["pending", "confirmed", "cancelled"] },
  })
    .populate("user", "name email")
    .sort({ appointmentTimeValue: 1 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="daily-bookings-${targetDate}.pdf"`
  );

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.registerFont("Amiri", amiriRegularPath);
  doc.registerFont("Amiri-Bold", amiriBoldPath);
  doc.pipe(res);
  doc.font("Amiri-Bold").fontSize(18).text("تقرير الحجوزات اليومية", { align: "right" });
  doc.moveDown(0.3);
  doc.font("Amiri").fontSize(12).text(
    `اسم الطبيب: ${profile.displayName || doctorUser?.name || doctorUser?.email || "-"}`,
    { align: "right" }
  );
  doc.font("Amiri").fontSize(12).text(`التاريخ: ${targetDate}`, { align: "right" });
  doc.moveDown(0.5);

  if (!appointments.length) {
    doc.moveDown(1);
    doc.fontSize(12).text("لا توجد مواعيد مؤكدة لهذا اليوم.", { align: "center" });
    doc.end();
    return;
  }

  const columnHeaders = ["اسم المريض", "تاريخ الحجز", "الوقت", "الحالة"];
  const columnWidths = [140, 90, 70, 80];
  const columnSpacing = 10;
  const startX = doc.page.width - doc.page.margins.right - columnWidths[0];
  const columnPositions = columnWidths.reduce((positions, width, index) => {
    if (index === 0) {
      positions.push(startX);
    } else {
      const last = positions[index - 1];
      positions.push(last - columnSpacing - columnWidths[index]);
    }
    return positions;
  }, []);

  const statusLabels = {
    pending: "قيد التأكيد",
    confirmed: "مقبولة",
    cancelled: "ملغاة",
  };

  doc.moveDown(0.5);
  doc.fontSize(10).font("Amiri-Bold");
  columnHeaders.forEach((header, index) => {
    doc.text(header, columnPositions[index], doc.y, {
      width: columnWidths[index],
      align: "right",
    });
  });
  doc.moveDown(0.8);
  doc.font("Amiri").fontSize(10);

  appointments.forEach((appointment, idx) => {
    if (doc.y > doc.page.height - 80) {
      doc.addPage();
      doc.font("Amiri-Bold").fontSize(10);
      columnHeaders.forEach((header, index) => {
        doc.text(header, columnPositions[index], doc.y, {
          width: columnWidths[index],
          align: "right",
        });
      });
      doc.moveDown(0.8);
      doc.font("Amiri").fontSize(10);
    }

    const rowValues = [
      appointment.user?.name || "مراجع مجهول",
      appointment.appointmentDate || appointment.appointmentDateIso || targetDate,
      appointment.appointmentTime || appointment.appointmentTimeValue || "",
      statusLabels[appointment.status] || appointment.status || "-",
    ];

    rowValues.forEach((value, index) => {
      doc.text(value, columnPositions[index], doc.y, {
        width: columnWidths[index],
        align: "right",
      });
    });
    doc.moveDown(0.8);

    if (idx === appointments.length - 1) {
      doc.moveDown(0.6);
      doc.font("Amiri-Bold").fontSize(11).text(
        `مجموع الحجوزات: ${appointments.length}`,
        columnPositions[columnPositions.length - 1],
        doc.y,
        {
          width: columnPositions[0] - columnPositions[columnPositions.length - 1] + columnWidths[0],
          align: "right",
        }
      );
      doc.font("Amiri").fontSize(10);
    }
  });

  doc.end();
});

// =========================
// Excel reports (daily + monthly)
// =========================

router.post("/doctors/me/daily-bookings/excel/link", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const dateIso = normalizeDateIso(req.body?.date || req.query?.date);
    const payload = {
      type: "daily-report-excel",
      userId: user._id.toString(),
      doctorProfileId: profile._id.toString(),
      date: dateIso,
    };
    const downloadToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "10m",
    });
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const downloadUrl = `${baseUrl}/api/reports/download/daily-excel?token=${encodeURIComponent(
      downloadToken
    )}`;

    return res.json({ downloadUrl, expiresIn: 600, date: dateIso });
  } catch (err) {
    console.error("Daily excel link error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/download/daily-excel", async (req, res) => {
  const { token } = req.query || {};
  if (!token) {
    return res.status(400).json({ message: "Download token is required" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    console.error("Excel download token error:", err.message);
    return res.status(401).json({ message: "Invalid or expired download token" });
  }

  if (payload.type !== "daily-report-excel") {
    return res.status(400).json({ message: "Invalid report token" });
  }

  const profile = await DoctorProfile.findById(payload.doctorProfileId);
  if (!profile || profile.user.toString() !== payload.userId) {
    return res.status(403).json({ message: "Unauthorized report download" });
  }

  const doctorUser = await User.findById(payload.userId).select("name email");
  const targetDate = normalizeDateIso(payload.date);

  const appointments = await Appointment.find({
    doctorProfile: profile._id,
    appointmentDateIso: targetDate,
    status: { $in: ["pending", "confirmed", "completed", "cancelled"] },
  })
    .populate("user", "name age")
    .sort({ appointmentTimeValue: 1, createdAt: 1 })
    .lean();

  const consultationFee = toMoney(profile.consultationFee);
  const rows = appointments.map((a) => {
    const price = toMoney(a?.service?.price) || consultationFee;
    return {
      patientName: a.user?.name,
      patientAge: a.user?.age,
      condition: (a.notes || "").trim(),
      price,
      date: a.appointmentDate || a.appointmentDateIso,
      time: a.appointmentTime || a.appointmentTimeValue,
      status: a.status,
      billable: a.status !== "cancelled" ? price : 0,
    };
  });

  const totals = {
    confirmedCount: rows.filter((r) => r.status === "confirmed").length,
    pendingCount: rows.filter((r) => r.status === "pending").length,
    cancelledCount: rows.filter((r) => r.status === "cancelled").length,
    totalMoney: rows.reduce(
      (sum, r) => sum + (r.status === "confirmed" ? toMoney(r.billable) : 0),
      0
    ),
  };

  const workbook = buildExcelWorkbook({
    title: "تقرير الحجوزات اليومية (Excel)",
    doctorName: profile.displayName || doctorUser?.name || doctorUser?.email || "-",
    periodLabel: `التاريخ: ${targetDate}`,
    rows,
    totals,
    totalsLabels: {
      confirmedCount: "عدد الحجوزات المؤكدة",
      pendingCount: "عدد الحجوزات غير مؤكدة",
      cancelledCount: "عدد الحجوزات الملغاة",
      money: "مجموع الفلوس (المؤكدة)",
    },
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="daily-bookings-${targetDate}.xlsx"`
  );

  await workbook.xlsx.write(res);
  res.end();
});

router.post("/doctors/me/monthly-bookings/excel/link", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "doctor") {
      return res.status(403).json({ message: "Restricted to doctors" });
    }

    const profile = await DoctorProfile.findOne({ user: user._id });
    if (!profile) {
      return res.status(404).json({ message: "Doctor profile not found" });
    }

    const monthIso = normalizeMonthIso(req.body?.month || req.query?.month);
    const payload = {
      type: "monthly-report-excel",
      userId: user._id.toString(),
      doctorProfileId: profile._id.toString(),
      month: monthIso,
    };

    const downloadToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "10m",
    });
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const downloadUrl = `${baseUrl}/api/reports/download/monthly-excel?token=${encodeURIComponent(
      downloadToken
    )}`;

    return res.json({ downloadUrl, expiresIn: 600, month: monthIso });
  } catch (err) {
    console.error("Monthly excel link error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/download/monthly-excel", async (req, res) => {
  const { token } = req.query || {};
  if (!token) {
    return res.status(400).json({ message: "Download token is required" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    console.error("Monthly excel token error:", err.message);
    return res.status(401).json({ message: "Invalid or expired download token" });
  }

  if (payload.type !== "monthly-report-excel") {
    return res.status(400).json({ message: "Invalid report token" });
  }

  const profile = await DoctorProfile.findById(payload.doctorProfileId);
  if (!profile || profile.user.toString() !== payload.userId) {
    return res.status(403).json({ message: "Unauthorized report download" });
  }

  const doctorUser = await User.findById(payload.userId).select("name email");
  const monthIso = normalizeMonthIso(payload.month);
  const { startIso, endIso } = getMonthRange(monthIso);

  const appointments = await Appointment.find({
    doctorProfile: profile._id,
    appointmentDateIso: { $gte: startIso, $lt: endIso },
    status: { $in: ["pending", "confirmed", "completed", "cancelled"] },
  })
    .populate("user", "name age")
    .sort({ appointmentDateIso: 1, appointmentTimeValue: 1, createdAt: 1 })
    .lean();

  const consultationFee = toMoney(profile.consultationFee);
  const rows = appointments.map((a) => {
    const price = toMoney(a?.service?.price) || consultationFee;
    return {
      patientName: a.user?.name,
      patientAge: a.user?.age,
      condition: (a.notes || "").trim(),
      price,
      date: a.appointmentDate || a.appointmentDateIso,
      time: a.appointmentTime || a.appointmentTimeValue,
      status: a.status,
      billable: a.status !== "cancelled" ? price : 0,
    };
  });

  const totals = {
    confirmedCount: rows.filter((r) => r.status === "confirmed").length,
    pendingCount: rows.filter((r) => r.status === "pending").length,
    cancelledCount: rows.filter((r) => r.status === "cancelled").length,
    totalMoney: rows.reduce(
      (sum, r) => sum + (r.status === "confirmed" ? toMoney(r.billable) : 0),
      0
    ),
  };

  const workbook = buildExcelWorkbook({
    title: "تقرير الحجوزات الشهري (Excel)",
    doctorName: profile.displayName || doctorUser?.name || doctorUser?.email || "-",
    periodLabel: `الشهر: ${monthIso}`,
    rows,
    totals,
    totalsLabels: {
      confirmedCount: "عدد الحجوزات المؤكدة",
      pendingCount: "عدد الحجوزات غير مؤكدة",
      cancelledCount: "عدد الحجوزات الملغاة",
      money: "مجموع الفلوس (المؤكدة)",
    },
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="monthly-bookings-${monthIso}.xlsx"`
  );

  await workbook.xlsx.write(res);
  res.end();
});

router.get("/users/emails", authMiddleware, authMiddleware.requireRole("admin"), async (req, res) => {
  try {
    const [doctorUsers, patientUsers] = await Promise.all([
      User.find({ role: "doctor" }).select("name email").lean(),
      User.find({ role: "patient" }).select("name email").lean(),
    ]);

    return res.json({
      doctors: doctorUsers,
      patients: patientUsers,
    });
  } catch (err) {
    console.error("User emails error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});


module.exports = router;
