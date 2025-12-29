// Script to fix the index for doctorQueueNumber per day (MongoDB partial index without $ne)
// Run this script with: node scripts/fix-appointment-index.js

const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('Please set MONGO_URI in your .env file');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  try {
    // Drop old index if exists
    try {
      await db.collection('appointments').dropIndex('doctorProfile_1_doctorQueueNumber_1');
      console.log('Dropped old index: doctorProfile_1_doctorQueueNumber_1');
    } catch (err) {
      console.log('Old index not found or already dropped.');
    }
    // Create new index (without $ne)
    await db.collection('appointments').createIndex(
      { doctorProfile: 1, appointmentDateIso: 1, doctorQueueNumber: 1 },
      {
        unique: true,
        partialFilterExpression: {
          doctorProfile: { $exists: true },
          appointmentDateIso: { $type: 'string' },
          doctorQueueNumber: { $type: 'number' },
        },
      }
    );
    console.log('Created new index for doctorQueueNumber per day!');
  } catch (err) {
    console.error('Error updating index:', err);
  } finally {
    await mongoose.disconnect();
  }
}

main();
