
const twilio = require('twilio');
const accountSid = process.env.ACCOUNT_SID;
const authToken = process.env.AUTH_TOKEN;
const fromNumber = process.env.PHONE_NUMBER;

const client = twilio(accountSid, authToken);

function normalizeInternationalPhone(phone) {
  let p = String(phone).replace(/\s|-/g, '').trim();
  // إذا الرقم لا يبدأ بـ +964، أضفها دائماً
  if (p.startsWith('+964')) {
    return p;
  }
  // إذا الرقم يبدأ بصفر، نحذف الصفر ونضيف +964
  if (p.startsWith('0')) {
    p = p.slice(1);
  }
  // أضف +964 دائماً
  return '+964' + p;
}

module.exports = async function sendSms(phone, message) {
  if (!phone || !message) {
    throw new Error("phone and message are required for SMS");
  }
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Twilio credentials are missing in environment variables");
  }
  const toPhone = normalizeInternationalPhone(phone);
  // إرسال عبر WhatsApp إذا كان الرقم عراقي
  const isIraq = toPhone.startsWith('+964');
  const whatsappTo = isIraq ? `whatsapp:${toPhone}` : toPhone;
  // استخدم الرقم الموجود في .env عند الإرسال عبر واتساب
  try {
    const result = await client.messages.create({
      body: message,
      from: isIraq ? `whatsapp:${fromNumber}` : fromNumber,
      to: whatsappTo
    });
    return result.sid;
  } catch (err) {
    console.error('Twilio SMS error:', err.message);
    throw err;
  }
};
