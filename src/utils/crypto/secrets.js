const crypto = require("crypto");
const { decryptLegacy } = require("./legacy_aes");

// ── Authenticated at-rest encryption for stored secrets (SMTP pass / API keys) ──
// AES-256-GCM with the FULL 32-byte key derived from ENCRYPTION_KEY. Unlike the
// legacy CBC routine this provides integrity (auth tag), so tampered ciphertext
// is rejected on decrypt. Output format: "gcm:<ivHex>:<tagHex>:<cipherHex>".
const ENC_GCM_PREFIX = "gcm:";

function secretKey() {
  return crypto.createHash("sha256").update(String(process.env.ENCRYPTION_KEY)).digest();
}

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_GCM_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

function decryptSecret(value) {
  if (typeof value === "string" && value.startsWith(ENC_GCM_PREFIX)) {
    const [ivHex, tagHex, ctHex] = value.slice(ENC_GCM_PREFIX.length).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
    return pt.toString("utf8");
  }
  // Backward-compat: read legacy AES-256-CBC values written before this change.
  return decryptLegacy(value);
}

module.exports = { encryptSecret, decryptSecret };
