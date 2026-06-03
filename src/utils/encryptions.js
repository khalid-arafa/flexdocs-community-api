const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Logger = require("./logger");
const { tokenExpiry } = require("../constants");
require("dotenv").config();

const BCRYPT_ROUNDS = 12;

// detect if a stored hash is bcrypt (starts with $2a$ or $2b$)
function isBcryptHash(hash) {
  return hash && (hash.startsWith("$2a$") || hash.startsWith("$2b$"));
}

// hash password with bcrypt
async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

// verify password against stored hash (supports both bcrypt and legacy AES)
// returns { match: boolean, needsRehash: boolean }
async function verifyPassword(plaintext, storedHash) {
  if (isBcryptHash(storedHash)) {
    const match = await bcrypt.compare(plaintext, storedHash);
    return { match, needsRehash: false };
  }
  // legacy AES-256-CBC format: try decrypt and compare
  try {
    const decrypted = decryptLegacy(storedHash);
    const decBuf = Buffer.from(decrypted, "utf8");
    const plainBuf = Buffer.from(plaintext, "utf8");
    const match = decBuf.length === plainBuf.length &&
      crypto.timingSafeEqual(decBuf, plainBuf);
    return { match, needsRehash: match }; // if matched, flag for rehash
  } catch {
    return { match: false, needsRehash: false };
  }
}

// legacy AES encrypt (kept only for backward-compat reads during migration)
function encryptLegacy(text) {
  let key = crypto
    .createHash("sha256")
    .update(String(process.env.ENCRYPTION_KEY))
    .digest("base64")
    .substr(0, 32);

  let iv = crypto.randomBytes(16);
  let cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key), iv);
  let encrypted = cipher.update(text);

  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

// legacy AES decrypt
function decryptLegacy(text) {
  let key = crypto
    .createHash("sha256")
    .update(String(process.env.ENCRYPTION_KEY))
    .digest("base64")
    .substr(0, 32);
  let textParts = text.split(":");
  let iv = Buffer.from(textParts.shift(), "hex");
  let encryptedText = Buffer.from(textParts.join(":"), "hex");
  let decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// generate a token
function getToken(obj, { expiresIn = tokenExpiry.auth } = {}) {
  try {
    const token = jwt.sign(obj, process.env.JWT_SECRET, { expiresIn });
    return token;
  } catch (error) {
    Logger.log(error.message, __filename);
    return null;
  }
}

// verify a token
function verifyToken(token) {
  try {
    const obj = jwt.verify(token, process.env.JWT_SECRET);
    return obj;
  } catch (error) {
    Logger.log(error.message, __filename);
    if (error.name === "TokenExpiredError") {
      return { expired: true };
    }
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  // legacy exports kept for migration period
  encrypt: encryptLegacy,
  decrypt: decryptLegacy,
  getToken,
  verifyToken,
};
