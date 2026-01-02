const Appointment = require("../models/Appointment");
const DoctorProfile = require("../models/DoctorProfile");
const { sendPushToUser } = require("../routes/notifications");
const sendSms = require("../utils/sendSms");

const toBool = (v) => String(v || "").toLowerCase() === "true";

const pad2 = (n) => String(n).padStart(2, "0");

const formatYmd = (d) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
};

const parseTimeHHmm = (timeLike) => {
  const raw = String(timeLike || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
};

const parseAppointmentDateTime = (appt) => {
  const dateIso = String(appt.appointmentDateIso || appt.appointmentDate || "").trim();
  const timeObj = parseTimeHHmm(appt.appointmentTimeValue || appt.appointmentTime);
  if (!dateIso || !timeObj) return null;
  // Interpret as server-local time (no Z)
  const dt = new Date(`${dateIso}T${pad2(timeObj.hh)}:${pad2(timeObj.mm)}:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
};

const safeSendSms = async (phone, message) => {
  if (!phone || !message) return;
  try {
    await sendSms(phone, message);
  } catch (e) {
    // Do not fail the whole job if Twilio is not configured.
    console.warn("SMS reminder failed:", e?.message || e);
  }
};

async function runAppointmentReminders({ reminderHours, windowMs, enableSms }) {
  const reminderMs = reminderHours * 60 * 60 * 1000;
  const now = Date.now();
  const dueStart = now + reminderMs;
  const dueEnd = now + reminderMs + windowMs;

  // Narrow scan to the next couple of days using ISO string ordering.
  const todayIso = formatYmd(now);
  const end = new Date(now);
  end.setDate(end.getDate() + Math.max(2, Math.ceil(reminderHours / 24) + 1));
  const endIso = formatYmd(end);

  const appts = await Appointment.find({
    status: "confirmed",
    appointmentDateIso: { $gte: todayIso, $lte: endIso },
  })
    .select(
      "user doctorName appointmentDateIso appointmentTimeValue appointmentTime patientReminderFor patientReminderSentAt"
    )
    .populate("user", "phone")
    .lean();

  const bulk = [];
  let sent = 0;

  for (const appt of appts) {
    const dt = parseAppointmentDateTime(appt);
    if (!dt) continue;

    const apptMs = dt.getTime();
    if (apptMs < dueStart || apptMs >= dueEnd) continue;

    const timeObj = parseTimeHHmm(appt.appointmentTimeValue || appt.appointmentTime);
    const timeStr = timeObj ? `${pad2(timeObj.hh)}:${pad2(timeObj.mm)}` : String(appt.appointmentTime || "");
    const key = `${appt.appointmentDateIso || formatYmd(dt)}T${timeStr}`;

    if (appt.patientReminderFor === key) continue;

    const title = "تذكير بالموعد";
    const body = `موعدك بعد ${reminderHours} ساعة مع ${appt.doctorName} الساعة ${timeStr}`;

    await sendPushToUser(appt.user?._id || appt.user, {
      title,
      body,
      data: { type: "appointment_reminder", role: "patient" },
    });

    if (enableSms) {
      const phone = appt.user?.phone;
      await safeSendSms(phone, body);
    }

    sent += 1;

    bulk.push({
      updateOne: {
        filter: { _id: appt._id },
        update: {
          $set: {
            patientReminderSentAt: new Date(),
            patientReminderFor: key,
            patientReminderHours: reminderHours,
          },
        },
      },
    });
  }

  if (bulk.length) {
    await Appointment.bulkWrite(bulk, { ordered: false });
  }

  return { scanned: appts.length, sent };
}

async function runSubscriptionExpiryReminders({ reminderDays, windowMs, enableSms }) {
  const daysMs = reminderDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const targetStart = new Date(now + daysMs);
  const targetEnd = new Date(now + daysMs + windowMs);

  const profiles = await DoctorProfile.find({
    status: "active",
    subscriptionEndsAt: { $ne: null, $gte: targetStart, $lt: targetEnd },
  })
    .select("user subscriptionEndsAt subscriptionExpiryReminderFor")
    .populate("user", "phone")
    .lean();

  const bulk = [];
  let sent = 0;

  for (const profile of profiles) {
    const endAt = profile.subscriptionEndsAt ? new Date(profile.subscriptionEndsAt) : null;
    if (!endAt || Number.isNaN(endAt.getTime())) continue;

    const forKey = endAt.toISOString();
    if (profile.subscriptionExpiryReminderFor === forKey) continue;

    const endDateStr = formatYmd(endAt);
    const title = "تنبيه انتهاء الاشتراك";
    const body = `اشتراكك ينتهي بتاريخ ${endDateStr}. يرجى التجديد لتجنب توقف الخدمة.`;

    await sendPushToUser(profile.user?._id || profile.user, {
      title,
      body,
      data: { type: "subscription_expiry", role: "doctor" },
    });

    if (enableSms) {
      const phone = profile.user?.phone;
      await safeSendSms(phone, body);
    }

    sent += 1;

    bulk.push({
      updateOne: {
        filter: { _id: profile._id },
        update: {
          $set: {
            subscriptionExpiryReminderSentAt: new Date(),
            subscriptionExpiryReminderFor: forKey,
          },
        },
      },
    });
  }

  if (bulk.length) {
    await DoctorProfile.bulkWrite(bulk, { ordered: false });
  }

  return { scanned: profiles.length, sent };
}

function startReminderJobs() {
  if (toBool(process.env.DISABLE_REMINDERS)) {
    console.log("Reminders: disabled via DISABLE_REMINDERS=true");
    return { stop: () => {} };
  }

  const reminderHours = Number(process.env.APPOINTMENT_REMINDER_HOURS || 2);
  const appointmentEveryMs = Number(process.env.APPOINTMENT_REMINDER_EVERY_MS || 5 * 60 * 1000);

  const subscriptionDays = Number(process.env.SUBSCRIPTION_EXPIRY_REMINDER_DAYS || 1);
  const subscriptionEveryMs = Number(process.env.SUBSCRIPTION_REMINDER_EVERY_MS || 60 * 60 * 1000);

  const enableSms = toBool(process.env.ENABLE_SMS_REMINDERS);

  const runSafely = async (name, fn) => {
    try {
      const result = await fn();
      if (result?.sent) {
        console.log(`${name}: sent=${result.sent} scanned=${result.scanned}`);
      }
    } catch (e) {
      console.error(`${name} failed:`, e);
    }
  };

  // Kick once at startup
  runSafely("Appointment reminders", () =>
    runAppointmentReminders({ reminderHours, windowMs: appointmentEveryMs, enableSms })
  );
  runSafely("Subscription expiry reminders", () =>
    runSubscriptionExpiryReminders({ reminderDays: subscriptionDays, windowMs: subscriptionEveryMs, enableSms })
  );

  const apptTimer = setInterval(() => {
    runSafely("Appointment reminders", () =>
      runAppointmentReminders({ reminderHours, windowMs: appointmentEveryMs, enableSms })
    );
  }, appointmentEveryMs);

  const subTimer = setInterval(() => {
    runSafely("Subscription expiry reminders", () =>
      runSubscriptionExpiryReminders({ reminderDays: subscriptionDays, windowMs: subscriptionEveryMs, enableSms })
    );
  }, subscriptionEveryMs);

  // Don't keep process alive solely for timers
  apptTimer.unref?.();
  subTimer.unref?.();

  console.log(
    `Reminders: appointment ${reminderHours}h every ${Math.round(appointmentEveryMs / 60000)}m; subscription ${subscriptionDays}d every ${Math.round(
      subscriptionEveryMs / 60000
    )}m; sms=${enableSms}`
  );

  return {
    stop: () => {
      clearInterval(apptTimer);
      clearInterval(subTimer);
    },
  };
}

module.exports = { startReminderJobs };
