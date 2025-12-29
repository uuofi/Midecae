// config/db.js
const mongoose = require("mongoose");
const User = require("../models/User");

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected:", conn.connection.host);

    // تنظيف السجلات الفارغة قبل بناء الفهارس لمنع التعارضات
    await User.deleteMany({ $or: [{ phone: null }, { phone: "" }] });
    await User.updateMany({ email: null }, { $unset: { email: 1 } });

    // إسقاط الفهارس القديمة التي تستخدم null
    const userCollection = mongoose.connection.collection("users");
    try {
      await userCollection.dropIndex("phone_1");
    } catch (dropErr) {
      if (dropErr.codeName !== "IndexNotFound") {
        console.warn("لم يتم إسقاط فهرس phone_1:", dropErr.message);
      }
    }
    try {
      await userCollection.dropIndex("email_1");
    } catch (dropErr) {
      if (dropErr.codeName !== "IndexNotFound") {
        console.warn("لم يتم إسقاط فهرس email_1:", dropErr.message);
      }
    }

    // مزامنة الفهارس بالفلاتر الجزئية الجديدة (تتجاهل null/undefined)
    await User.syncIndexes();
  } catch (err) {
    console.error("Database Error:", err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
