// routes/notifications.js
const express = require("express");
const { Expo } = require("expo-server-sdk");
const authMiddleware = require("../middleware/authMiddleware");
const User = require("../models/User");

const router = express.Router();
const expo = new Expo();

// POST /api/notifications/register-token
// يستقبل expoPushToken من الموبايل ويخزّنه للمستخدم الحالي
router.post("/register-token", authMiddleware, async (req, res) => {
  try {
    const { expoPushToken } = req.body;

    if (!expoPushToken) {
      return res.status(400).json({ error: "expoPushToken is required" });
    }

    if (!Expo.isExpoPushToken(expoPushToken)) {
      return res.status(400).json({ error: "Invalid Expo push token" });
    }

    await User.findByIdAndUpdate(
      req.user.id,
      { expoPushToken },
      { new: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("Error registering push token:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// دالة عامة لإرسال إشعار لمستخدم معيّن
async function sendPushToUser(userId, { title, body, data }) {
  try {
    const user = await User.findById(userId).select("expoPushToken");
    if (!user || !user.expoPushToken) {
      return;
    }

    const pushToken = user.expoPushToken;
    if (!Expo.isExpoPushToken(pushToken)) {
      console.warn("Invalid Expo push token for user", userId);
      return;
    }

    const messages = [
      {
        to: pushToken,
        sound: "default",
        title: title || "إشعار جديد",
        body: body || "",
        data: data || {},
      },
    ];

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        console.log("Expo ticket:", ticketChunk);
      } catch (error) {
        console.error("Error sending push chunk:", error);
      }
    }
  } catch (err) {
    console.error("sendPushToUser error:", err);
  }
}

// دالة عامة لإرسال إشعار لمجموعة توكنات (bulk)
async function sendPushToTokens(tokens = [], { title, body, data } = {}) {
  const rawTokens = Array.isArray(tokens) ? tokens : [];
  const uniqueTokens = Array.from(
    new Set(rawTokens.map((t) => String(t || "").trim()).filter(Boolean))
  );

  const invalidTokens = [];
  const validTokens = [];
  uniqueTokens.forEach((t) => {
    if (!Expo.isExpoPushToken(t)) invalidTokens.push(t);
    else validTokens.push(t);
  });

  if (!validTokens.length) {
    return {
      totalTokens: uniqueTokens.length,
      validTokens: 0,
      invalidTokens,
      successCount: 0,
      failureCount: 0,
    };
  }

  const messages = validTokens.map((pushToken) => ({
    to: pushToken,
    sound: "default",
    title: title || "إشعار جديد",
    body: body || "",
    data: data || {},
  }));

  let successCount = 0;
  let failureCount = 0;
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (const t of tickets) {
        if (t && t.status === "ok") successCount += 1;
        else failureCount += 1;
      }
    } catch (error) {
      // if a whole chunk fails, count them as failures
      failureCount += chunk.length;
      console.error("Error sending push chunk:", error);
    }
  }

  return {
    totalTokens: uniqueTokens.length,
    validTokens: validTokens.length,
    invalidTokens,
    successCount,
    failureCount,
  };
}

module.exports = { router, sendPushToUser, sendPushToTokens };
