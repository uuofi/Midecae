const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
      index: true,
    },
    senderType: {
      type: String,
      enum: ["doctor", "patient"],
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    text: {
      type: String,
      required: function () {
        return !this.e2ee;
      },
      trim: true,
    },
    encrypted: {
      type: Boolean,
      default: true,
    },

    // End-to-end encryption payload (client-side).
    // When e2ee=true, the server MUST NOT decrypt or re-encrypt content.
    e2ee: {
      type: Boolean,
      default: false,
      index: true,
    },
    e2eeVersion: {
      type: Number,
      default: 1,
      min: 1,
    },
    e2eeAlg: {
      type: String,
      default: "x25519-xsalsa20-poly1305",
      trim: true,
    },
    e2eeNonce: {
      type: String,
      default: "",
      trim: true,
    },
    e2eeCiphertext: {
      type: String,
      default: "",
      trim: true,
    },
    deleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
