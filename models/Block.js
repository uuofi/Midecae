const mongoose = require("mongoose");

const blockSchema = new mongoose.Schema(
  {
    doctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    blockChat: {
      type: Boolean,
      default: false,
    },
    blockBooking: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

blockSchema.index({ doctor: 1, patient: 1 }, { unique: true });

module.exports = mongoose.model("Block", blockSchema);
