const crypto = require("crypto");

const ALGO = "aes-256-gcm";

const isProduction = () => String(process.env.NODE_ENV || "").toLowerCase() === "production";

const deriveKey = () => {
  const raw = String(process.env.MESSAGE_KEY || "");
  if (!raw) return null;

  // Backwards-compatible derivation (matches legacy implementation used in server/routes):
  // take first 32 chars and pad with zeros if shorter.
  // Note: This is not ideal cryptography if MESSAGE_KEY is short, but it preserves
  // the ability to decrypt already-stored legacy messages.
  const keyString = raw.slice(0, 32).padEnd(32, "0");
  return Buffer.from(keyString, "utf8");
};

const assertCryptoReady = () => {
  const key = deriveKey();
  if (!key) {
    const msg = "MESSAGE_KEY is missing; legacy message encryption/decryption is not available";
    if (isProduction()) {
      const err = new Error(msg);
      err.code = "E_MESSAGE_KEY_MISSING";
      throw err;
    }
    // In non-production, do not crash; callers can handle this.
    return null;
  }
  return key;
};

const encryptAtRest = (plainText) => {
  const key = assertCryptoReady();
  if (!key) throw new Error("Legacy message crypto not configured");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(String(plainText || ""), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${enc.toString("hex")}.${tag.toString("hex")}`;
};

const decryptAtRest = (payload) => {
  const key = assertCryptoReady();
  if (!key) return "";

  try {
    const [ivHex, dataHex, tagHex] = String(payload || "").split(".");
    if (!ivHex || !dataHex || !tagHex) return "";

    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);

    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);

    return dec.toString("utf8");
  } catch {
    return "";
  }
};

const isLegacyMessageCryptoConfigured = () => !!deriveKey();

module.exports = {
  encryptAtRest,
  decryptAtRest,
  isLegacyMessageCryptoConfigured,
};
