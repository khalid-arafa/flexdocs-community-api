const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { decryptLegacy } = require("./legacy_aes");

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

module.exports = {
  hashPassword,
  verifyPassword,
  burnPasswordComparison,
};
