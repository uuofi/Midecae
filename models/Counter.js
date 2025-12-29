const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, index: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Counter", counterSchema);
