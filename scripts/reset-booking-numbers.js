/*
  Reset bookingNumber for all appointments and re-number from 1.

  Usage:
    - Ensure MONGO_URI is set (same as backend).
    - Recommended: stop the API server while running.
    - Run: node scripts/reset-booking-numbers.js
*/

const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config();

const Appointment = require("../models/Appointment");
const Counter = require("../models/Counter");

const mustGetMongoUri = () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("Missing MONGO_URI env var");
  }
  return uri;
};

const main = async () => {
  const mongoUri = mustGetMongoUri();
  await mongoose.connect(mongoUri);

  const total = await Appointment.countDocuments({});
  console.log(`Found ${total} appointments`);

  // 1) Clear bookingNumber + QR fields to avoid any uniqueness conflicts.
  const unsetResult = await Appointment.updateMany(
    {},
    {
      $unset: {
        bookingNumber: 1,
        qrCode: 1,
        qrPayload: 1,
      },
    }
  );
  console.log(
    `Cleared bookingNumber/qr fields for ${unsetResult.modifiedCount ?? unsetResult.nModified ?? 0} appointments`
  );

  // 2) Re-number sequentially by creation date.
  const cursor = Appointment.find({}).sort({ createdAt: 1 }).cursor();
  let seq = 0;

  for await (const appt of cursor) {
    seq += 1;
    await Appointment.updateOne(
      { _id: appt._id },
      {
        $set: { bookingNumber: String(seq) },
      }
    );
  }

  // 3) Reset the counter so new bookings continue from the end.
  await Counter.findOneAndUpdate(
    { key: "bookingNumber" },
    { $set: { seq } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  console.log(`Done. bookingNumber re-numbered 1..${seq} and counter set to ${seq}.`);
};

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Reset booking numbers failed:", err?.message || err);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  });
