const mongoose = require("mongoose");

const doctorServiceSchema = new mongoose.Schema(
  {
    doctorProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorProfile",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    durationMinutes: {
      type: Number,
      required: true,
      min: 1,
      default: 20,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

// Prevent exact duplicate active services per doctor (same name + duration + price)
// Note: partial unique indexes are supported by MongoDB.
doctorServiceSchema.index(
  { doctorProfile: 1, name: 1, price: 1, durationMinutes: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

module.exports = mongoose.model("DoctorService", doctorServiceSchema);
