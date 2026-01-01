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