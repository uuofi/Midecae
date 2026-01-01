const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const connectDB = require('../config/db');
const User = require('../models/User');

dotenv.config();

const normalizePhone = (phone) => {
  let p = String(phone || "").replace(/\s|-/g, "").trim();
  // إذا الرقم يبدأ بـ +964 ويليه 10 أرقام
  if (/^\+964\d{10}$/.test(p)) return p;
  // إذا الرقم يبدأ بـ 0 ويليه 10 أرقام
  if (/^0\d{10}$/.test(p)) return "+964" + p.slice(1);
  // إذا الرقم فقط 10 أرقام (بدون صفر أو +964)
  if (/^\d{10}$/.test(p)) return "+964" + p;
  return p;
};
(async () => {
  try {
    await connectDB();
    const phone = process.env.ADMIN_PHONE;
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME || 'Admin';
    if (!phone) {
      console.error('Please set ADMIN_PHONE in .env');
      process.exit(1);
    }
    const normalized = normalizePhone(phone);
    let user = await User.findOne({ phone: normalized });
    if (user) {
      user.role = 'admin';
      user.phoneVerified = true;

      if (typeof process.env.ADMIN_NAME === 'string' && process.env.ADMIN_NAME.trim()) {
        user.name = process.env.ADMIN_NAME.trim();
      }

      // Only update password for existing user when ADMIN_PASSWORD is explicitly set.
      if (typeof password === 'string' && password.trim()) {
        const hashed = await bcrypt.hash(password, 12);
        user.password = hashed;
      }

      await user.save();
      console.log('Updated existing user to admin:', normalized);
      process.exit(0);
    }
    const finalPassword = (typeof password === 'string' && password.trim()) ? password : 'admin123A';
    const hashed = await bcrypt.hash(finalPassword, 12);
    user = await User.create({ name, phone: normalized, password: hashed, role: 'admin', phoneVerified: true });
    console.log('Created admin user:', normalized);
    process.exit(0);
  } catch (err) {
    console.error('Create admin error:', err);
    process.exit(1);
  }
})();
