const nodemailer = require("nodemailer");

module.exports = async function sendVerificationEmail(to, code) {
  let transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "YOUR_EMAIL@gmail.com",
      pass: "YOUR_APP_PASSWORD",
    },
  });

  await transporter.sendMail({
    from: '"MediCare App" <YOUR_EMAIL@gmail.com>',
    to,
    subject: "Verify Your Email",
    text: `Your verification code is: ${code}`,
    html: `<h2>Your verification code:</h2>
           <h1>${code}</h1>`,
  });
};
