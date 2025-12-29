const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const connectDB = require('../config/db');
const User = require('../models/User');

dotenv.config();
(async () => {
  try {
    await connectDB();
    const phone = process.env.ADMIN_PHONE;
    const password = process.env.ADMIN_PASSWORD || 'admin123A';
    const name = process.env.ADMIN_NAME || 'Admin';
    if (!phone) {
      console.error('Please set ADMIN_PHONE in .env');
      process.exit(1);
    }
    const normalized = phone.replace(/\s|-/g, '');
    let user = await User.findOne({ phone: normalized });
    if (user) {
      user.role = 'admin';
      user.phoneVerified = true;
      await user.save();
      console.log('Updated existing user to admin:', normalized);
      process.exit(0);
    }
    const hashed = await bcrypt.hash(password, 12);
    user = await User.create({ name, phone: normalized, password: hashed, role: 'admin', phoneVerified: true });
    console.log('Created admin user:', normalized);
    process.exit(0);
  } catch (err) {
    console.error('Create admin error:', err);
    process.exit(1);
  }
})();
