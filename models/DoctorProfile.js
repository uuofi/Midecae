const mongoose = require("mongoose");

const defaultSchedule = {
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

const scheduleSchema = new mongoose.Schema(
  {
    activeDays: {
      type: [String],
      default: () => [...defaultSchedule.activeDays],
    },
    startTime: {
      type: String,
      default: defaultSchedule.startTime,
    },
    endTime: {
      type: String,
      default: defaultSchedule.endTime,
    },
    breakEnabled: {
      type: Boolean,
      default: defaultSchedule.breakEnabled,
    },
    breakFrom: {
      type: String,
      default: defaultSchedule.breakFrom,
    },
    breakTo: {
      type: String,
      default: defaultSchedule.breakTo,
    },
    duration: {
      type: Number,
      default: defaultSchedule.duration,
    },
    allowOnline: {
      type: Boolean,
      default: defaultSchedule.allowOnline,
    },
    emergency: {
      type: Boolean,
      default: defaultSchedule.emergency,
    },
  },
  { _id: false }
);

const doctorProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
    },
    avatarUrl: {
      type: String,
      default: "",
    },
    location: {
      type: String,
      default: "",
    },
    locationLat: {
      type: Number,
      default: null,
    },
    locationLng: {
      type: Number,
      default: null,
    },
    certification: {
      type: String,
      default: "",
    },
    cv: {
      type: String,
      default: "",
    },
    consultationFee: {
      type: Number,
      default: 0,
    },
    specialty: {
      type: String,
      default: "",
    },
    licenseNumber: {
      type: String,
      default: "",
    },
    isAcceptingBookings: {
      type: Boolean,
      default: true,
    },
    isChatEnabled: {
      type: Boolean,
      default: true,
    },
    specialtySlug: {
      type: String,
      default: "",
    },
    specialtyLabel: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "active", "inactive"],
      default: "pending",
    },
    bio: {
      type: String,
      default: "",
    },
    secretaryPhone: {
      type: String,
      default: "",
      trim: true,
    },
    schedule: {
      type: scheduleSchema,
      default: () => ({ ...defaultSchedule }),
    },
    subscriptionPlan: {
      type: String,
      default: "free",
    },
    subscriptionStartsAt: {
      type: Date,
      default: null,
    },
    subscriptionEndsAt: {
      type: Date,
      default: null,
    },
    subscriptionGraceEndsAt: {
      type: Date,
      default: null,
    },
    subscriptionUpdatedAt: {
      type: Date,
      default: null,
    },
    subscriptionUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Reminders (to avoid duplicate notifications)
    subscriptionExpiryReminderSentAt: {
      type: Date,
      default: null,
    },
    // ISO string for the subscriptionEndsAt that was notified
    subscriptionExpiryReminderFor: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DoctorProfile", doctorProfileSchema);
