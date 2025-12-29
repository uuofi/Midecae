// utils/sendVerificationEmail.js
const nodemailer = require("nodemailer");

async function sendVerificationEmail(to, code) {
  console.log("Preparing to send email via Brevo to:", to, "code:", code);

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,      // من .env
    port: process.env.EMAIL_PORT,      // 587 عادةً
    secure: false,                     // TLS
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: `"MediCare" <${process.env.EMAIL_USER}>`,
      to,
      subject: "Verify your email",
      text: `Your verification code is: ${code}`,
      html: `
        <h2>Your verification code:</h2>
        <h1 style="letter-spacing:4px;">${code}</h1>
      `,
    });

    console.log("✅ Email sent via Brevo, messageId:", info.messageId);
  } catch (err) {
    console.error("❌ Error sending email via Brevo:", err.message);
    throw err;
  }
}

module.exports = sendVerificationEmail;
