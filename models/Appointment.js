const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    doctorName: {
      type: String,
      required: true,
      trim: true,
    },
    doctorRole: {
      type: String,
      required: true,
      trim: true,
    },
    specialty: {
      type: String,
      required: true,
      trim: true,
    },
    specialtySlug: {
      type: String,
      required: true,
      trim: true,
    },
    doctorProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorProfile",
      default: null,
    },
    appointmentDate: {
      type: String,
      required: true,
    },
    appointmentDateIso: {
      type: String,
      trim: true,
    },
    appointmentTime: {
      type: String,
      required: true,
    },
    appointmentTimeValue: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "confirmed", "completed", "cancelled"],
      default: "pending",
    },
    notes: {
      type: String,
      default: "",
    },
    doctorNote: {
      type: String,
      default: "",
      trim: true,
    },
    doctorPrescriptions: {
      type: [String],
      default: [],
    },
    createdByDoctor: {
      type: Boolean,
      default: false,
    },
    bookingNumber: {
      type: String,
      trim: true,
      default: "",
      index: true,
      unique: true,
      sparse: true,
    },
    // Per-doctor sequential number (1,2,3...) assigned at booking time and never reused.
    doctorQueueNumber: {
      type: Number,
      default: null,
      index: true,
    },
    qrCode: {
      type: String,
      default: "",
      trim: true,
    },
    qrPayload: {
      type: String,
      default: "",
      trim: true,
    },

    // Selected service snapshot (price is stored at booking time and should not be client-controlled)
    service: {
      serviceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "DoctorService",
        default: null,
      },
      name: {
        type: String,
        default: "",
        trim: true,
      },
      price: {
        type: Number,
        default: 0,
        min: 0,
      },
      durationMinutes: {
        type: Number,
        default: 0,
        min: 0,
      },
    },

    // Reminders (to avoid duplicate notifications)
    patientReminderSentAt: {
      type: Date,
      default: null,
    },
    // Key like: 2026-01-02T10:30
    patientReminderFor: {
      type: String,
      default: "",
      trim: true,
    },
    patientReminderHours: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true }
);

appointmentSchema.index(
  { doctorProfile: 1, appointmentDateIso: 1, appointmentTimeValue: 1 },
  {
    unique: true,
    partialFilterExpression: {
      doctorProfile: { $exists: true },
      appointmentDateIso: { $type: "string", $ne: "" },
      appointmentTimeValue: { $type: "string", $ne: "" },
      status: { $in: ["pending", "confirmed"] },
    },
  }
);

appointmentSchema.index(
  { doctorProfile: 1, appointmentDateIso: 1, doctorQueueNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      doctorProfile: { $exists: true },
      appointmentDateIso: { $type: "string" },
      doctorQueueNumber: { $type: "number" },
    },
  }
);

module.exports = mongoose.model("Appointment", appointmentSchema);