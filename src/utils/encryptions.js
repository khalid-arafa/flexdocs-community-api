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

// Burn one bcrypt comparison against a throwaway hash.
//
// Login answers "Invalid email or password" for both an unknown address and a
// wrong password, but it only PAYS for bcrypt in the second case — an unknown
// address returns in a few milliseconds while a real one costs ~250ms at 12
// rounds. That difference is measurable over the network and re-opens the
// account enumeration the shared message exists to close. Callers await this on
// the user-not-found path so both answers cost the same.
//
// The hash is generated once, lazily, at whatever BCRYPT_ROUNDS is configured,
// so the decoy tracks the real cost automatically if the rounds ever change.
let dummyHashPromise = null;
async function burnPasswordComparison(plaintext) {
  if (!dummyHashPromise)
    dummyHashPromise = bcrypt.hash("password-that-matches-nothing", BCRYPT_ROUNDS);
  try {
    await bcrypt.compare(String(plaintext ?? ""), await dummyHashPromise);
  } catch {
    // A decoy comparison must never change the outcome of the caller.
  }
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

// JWTs are symmetric (HMAC) — pin the algorithm on both sign and verify so a
// token can never be coerced into "alg":"none" or an asymmetric confusion.
const JWT_ALGORITHM = "HS256";

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

// generate a token
function getToken(obj, { expiresIn = tokenExpiry.auth } = {}) {
  try {
    const token = jwt.sign(obj, process.env.JWT_SECRET, {
      expiresIn,
      algorithm: JWT_ALGORITHM,
    });
    return token;
  } catch (error) {
    Logger.log(error.message, __filename);
    return null;
  }
}

// verify a token
function verifyToken(token) {
  try {
    const obj = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
    });
    return obj;
  } catch (error) {
    Logger.log(error.message, __filename);
    if (error.name === "TokenExpiredError") {
      return { expired: true };
    }
    return null;
  }
}

// Read the claims out of a token whose only defect is that it has expired.
//
// Signature and algorithm are still enforced — `ignoreExpiration` relaxes
// exactly one check and nothing else, so a forged or tampered token is still
// rejected (returns null). Callers must have some other means of deciding the
// credential is still live; today that is socketAuth matching the project
// token against the project's stored `projectTokenHash`, mirroring how REST
// authenticates the same credential. Do not use this to wave through user
// session tokens: their expiry is the only thing bounding a stolen session.
function decodeExpiredToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      ignoreExpiration: true,
    });
  } catch (error) {
    Logger.log(error.message, __filename);
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  burnPasswordComparison,
  // legacy exports kept for migration period
  encrypt: encryptLegacy,
  decrypt: decryptLegacy,
  // authenticated at-rest secret encryption (preferred)
  encryptSecret,
  decryptSecret,
  getToken,
  verifyToken,
  decodeExpiredToken,
  JWT_ALGORITHM,
};
