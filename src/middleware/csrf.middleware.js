const crypto = require("crypto");
const { authCookieNames } = require("../constants");

const CSRF_COOKIE = "csrf-token";
const CSRF_HEADER = "x-csrf-token";
const TOKEN_LENGTH = 32;

// Methods that mutate state and need CSRF protection
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Double-submit cookie CSRF protection.
 *
 * - On every response, sets a random CSRF token cookie (if not already present).
 * - On unsafe requests that use cookie-based auth (no Bearer token), verifies
 *   the x-csrf-token header matches the cookie value.
 * - Requests using only Bearer tokens (SDK/mobile) are exempt since they
 *   are not vulnerable to CSRF.
 */
function csrfProtection(req, res, next) {
  // Ensure a CSRF cookie is always set
  let cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
  if (!cookieToken) {
    cookieToken = crypto.randomBytes(TOKEN_LENGTH).toString("hex");
    res.cookie(CSRF_COOKIE, cookieToken, {
      httpOnly: false, // JS must be able to read it to send in header
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  }

  // Safe methods don't need CSRF checks
  if (!UNSAFE_METHODS.has(req.method)) return next();

  // If the request uses only a Bearer token (no auth cookies), skip CSRF —
  // Bearer-only requests are not vulnerable to CSRF attacks.
  const authHeader = req.headers.authorization;
  const hasBearerToken = authHeader && authHeader.startsWith("Bearer ");
  const hasAuthCookie =
    (req.cookies && req.cookies[authCookieNames.system]) ||
    (req.cookies && req.cookies[authCookieNames.dbUser]) ||
    (req.cookies && req.cookies[authCookieNames.legacy]);

  if (hasBearerToken && !hasAuthCookie) return next();

  // No cookies at all means an unauthenticated or SDK request — skip
  if (!hasAuthCookie) return next();

  // Cookie-based auth: require a matching CSRF header
  const headerToken = req.headers[CSRF_HEADER];
  if (!headerToken || headerToken !== cookieToken) {
    return res.status(403).json({ message: "Invalid or missing CSRF token" });
  }

  next();
}

module.exports = { csrfProtection };
