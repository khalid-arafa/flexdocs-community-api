// Re-export barrel. The implementation lives in ./crypto/*, split by concern:
//
//   crypto/jwt.js          — sign/verify session & project tokens
//   crypto/password.js     — bcrypt hashing and verification
//   crypto/legacy_aes.js   — AES-256-CBC, read-only backward compat
//   crypto/secrets.js      — AES-256-GCM at-rest encryption for stored secrets
//   crypto/storage_urls.js — HMAC signatures for time-limited download links
//
// This module stays the single public entry point so the ~15 call sites across
// routes, middleware, sockets and services (and the tests that jest.mock this
// path) need no change. New code may import the focused module directly, but
// keep exporting everything from here.
require("dotenv").config();

const {
  JWT_ALGORITHM,
  getToken,
  verifyToken,
  decodeExpiredToken,
} = require("./crypto/jwt");
const {
  hashPassword,
  verifyPassword,
  burnPasswordComparison,
} = require("./crypto/password");
const { encryptLegacy, decryptLegacy } = require("./crypto/legacy_aes");
const { encryptSecret, decryptSecret } = require("./crypto/secrets");
const {
  signStorageUrl,
  verifyStorageUrlSignature,
} = require("./crypto/storage_urls");

module.exports = {
  hashPassword,
  verifyPassword,
  burnPasswordComparison,
  signStorageUrl,
  verifyStorageUrlSignature,
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
