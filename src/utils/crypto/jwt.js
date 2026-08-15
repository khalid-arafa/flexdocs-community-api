const jwt = require("jsonwebtoken");
const Logger = require("../logger");
const { tokenExpiry } = require("../../constants");

// JWTs are symmetric (HMAC) — pin the algorithm on both sign and verify so a
// token can never be coerced into "alg":"none" or an asymmetric confusion.
const JWT_ALGORITHM = "HS256";

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
  JWT_ALGORITHM,
  getToken,
  verifyToken,
  decodeExpiredToken,
};
