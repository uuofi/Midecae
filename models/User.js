
// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
     loginCode: {
      type: String,
      default: null,
    },
    loginCodeExpires: {
      type: Date,
      default: null,
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: undefined,
    },

    password: {
      type: String,
      required: true,
      minlength: 6,
    },

    role: {
      type: String,
      enum: ["patient", "doctor", "admin"],
      default: "patient",
    },

    doctorProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorProfile",
      default: null,
    },

    age: {
      type: Number,
      min: 1,
      max: 120,
    },

    // هل الرقم مفعّل؟
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    // كود التفعيل اللي ينبعث للإيميل
    verificationCode: {
      type: String,
      default: null,
    },
    // Expo push notification token
    expoPushToken: {
      type: String,
      default: "",
      trim: true,
    },

    // Admin controls (patients)
    isBlocked: {
      type: Boolean,
      default: false,
    },
    blockedAt: {
      type: Date,
      default: null,
    },
    blockedReason: {
      type: String,
      default: "",
      trim: true,
    },

    // Auth session invalidation (logout everywhere / password change)
    tokenVersion: {
      type: Number,
      default: 0,
      min: 0,
    },

    // E2EE chat public key (base64). Private key must never be stored on server.
    chatPublicKey: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true }
);

userSchema.index(
  { phone: 1 },
  {
    unique: true,
    name: "unique_phone",
  }
);

userSchema.index(
  { email: 1 },
  {
    unique: true,
    sparse: true,
    name: "unique_email_sparse",
  }
);

userSchema.pre("save", function (next) {
  if (!this.email) {
    this.email = undefined;
  }
  next();
});

module.exports = mongoose.model("User", userSchema);
