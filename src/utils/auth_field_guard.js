const { authCollectionName } = require("../constants");

// Fields that only server-side auth logic ever sets — lockedUntil and
// failedLoginAttempts drive the brute-force lockout in auth_service.js,
// tokenVersion is the entire session-revocation mechanism (see
// user_auth.middleware.js), and resetPasswordToken gates password resets.
// No legitimate client-facing endpoint writes any of them.
//
// The generic /:col and /:col/:id routes can never reach the auth collection
// (validateCollectionParam in db_rules.middleware.js rejects "_users" both by
// its leading underscore and via reservedCollectionNames), so the one real
// call site is PUT /accounts/:id — an admin-only route with an unfiltered
// body. Left unstripped there, a write to the auth collection could silently
// disable lockout (an invalid lockedUntil makes the Date comparison always
// false) or un-revoke a token by resetting tokenVersion downward.
const PROTECTED_AUTH_FIELDS = [
  "lockedUntil",
  "failedLoginAttempts",
  "tokenVersion",
  "resetPasswordToken",
];

/**
 * Returns `data` with PROTECTED_AUTH_FIELDS removed when `collectionName` is
 * the auth collection; returns `data` unchanged for every other collection.
 */
function stripProtectedAuthFields(collectionName, data) {
  if (collectionName !== authCollectionName || !data || typeof data !== "object") {
    return data;
  }
  const cleaned = { ...data };
  for (const field of PROTECTED_AUTH_FIELDS) delete cleaned[field];
  return cleaned;
}

module.exports = { PROTECTED_AUTH_FIELDS, stripProtectedAuthFields };
