const { tokenExpiry } = require("../constants");
const Logger = require("./logger");

/**
 * Per-project auth token lifetime (N6 / B9's expiry ladder).
 *
 * FlexDocs JWTs are stateless and were minted with a flat 30-day expiry, which
 * means a stolen token is good for a month. Shortening that is only safe once
 * the clients for a project can refresh — the Flutter SDK gained
 * `refreshToken()` in 0.2.0, the JS SDK separately — so the lifetime is a
 * per-project setting rather than a global change. A project whose clients
 * cannot refresh keeps 30 days by leaving it unset.
 *
 * Intended progression per project, each rung soaked before the next:
 * 30d (default) → 7d → 1d.
 *
 * **This governs USER auth tokens only — never project tokens.** Those are
 * minted separately by `generateProjectCreds` in utils/helper.js with no
 * `expiresIn`, and the distinction is load-bearing: a project token is baked
 * into client bundles at build time, is handed to every anonymous visitor, and
 * has no refresh path anywhere, so shortening one takes a site down until it
 * is rebuilt and redeployed. Keep the two knobs apart.
 */

// A whole number of minutes, hours or days. Deliberately not accepting
// seconds: nothing legitimate needs a sub-minute auth token, and `30s` is far
// more likely to be a typo for `30d` than a real intent.
const DURATION_PATTERN = /^(\d+)([mhd])$/;
const MINUTES_PER_UNIT = { m: 1, h: 60, d: 24 * 60 };

// Bounds exist so a fat-fingered value cannot lock every user of a project out
// on their next request, nor quietly issue a token that outlives the default.
const MIN_MINUTES = 5;
const MAX_MINUTES = 30 * 24 * 60;

/** Duration in minutes, or null if the string isn't a valid bounded duration. */
function durationMinutes(value) {
  if (typeof value !== "string") return null;
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * MINUTES_PER_UNIT[match[2]];
  if (!Number.isFinite(minutes)) return null;
  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) return null;
  return minutes;
}

function isValidAuthTokenExpiry(value) {
  return durationMinutes(value) !== null;
}

/**
 * The expiry to mint this project's auth tokens with.
 *
 * Fails SAFE in both directions: an unset value gives the 30-day default, and
 * a stored value that is somehow invalid (hand-edited in Mongo, or written
 * before validation existed) also gives the default rather than throwing —
 * refusing to mint a token would lock the project's users out entirely, which
 * is a far worse outcome than an expiry that is longer than intended.
 */
function authTokenExpiryFor(project) {
  const configured = project && project.authTokenExpiry;
  if (configured === undefined || configured === null || configured === "") {
    return tokenExpiry.auth;
  }
  if (!isValidAuthTokenExpiry(configured)) {
    Logger.warn(
      `Ignoring invalid authTokenExpiry ${JSON.stringify(configured)} on project ` +
        `${project && project.code}; falling back to ${tokenExpiry.auth}`,
    );
    return tokenExpiry.auth;
  }
  return configured;
}

module.exports = {
  authTokenExpiryFor,
  isValidAuthTokenExpiry,
  durationMinutes,
  ALLOWED_RANGE: { minMinutes: MIN_MINUTES, maxMinutes: MAX_MINUTES },
};
