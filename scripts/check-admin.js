const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const connectDB = require('../config/db');
const User = require('../models/User');

dotenv.config();

const normalizePhone = (phone) => {
  let p = String(phone || '').replace(/\s|-/g, '').trim();
  if (/^\+964\d{10}$/.test(p)) return p;
  if (/^0\d{10}$/.test(p)) return '+964' + p.slice(1);
  if (/^\d{10}$/.test(p)) return '+964' + p;
  return p;
};

(async () => {
  try {
    await connectDB();

    const phone = process.env.ADMIN_PHONE;
    const password = process.env.ADMIN_PASSWORD;

    if (!phone) {
      console.error('ADMIN_PHONE is missing in env');
      process.exit(1);
    }

    const normalized = normalizePhone(phone);
    const user = await User.findOne({ phone: normalized }).select('phone role password phoneVerified');

    if (!user) {
      console.error('Admin user not found in DB for phone:', normalized);
      process.exit(2);
    }

    console.log('Admin user found:', {
      phone: user.phone,
      role: user.role,
      phoneVerified: user.phoneVerified,
      hasPassword: Boolean(user.password),
    });

    if (typeof password === 'string' && password.trim()) {
      const ok = await bcrypt.compare(password, user.password);
      console.log('ADMIN_PASSWORD matches stored hash:', ok);
      process.exit(ok ? 0 : 3);
    }

    console.log('ADMIN_PASSWORD not set; skipped password check.');
    process.exit(0);
  } catch (err) {
    console.error('check-admin error:', err?.message || err);
    process.exit(99);
  }
})();
