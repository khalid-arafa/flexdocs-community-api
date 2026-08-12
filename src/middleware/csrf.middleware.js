const crypto = require("crypto");
const { authCookieNames } = require("../constants");
const { csrfCookieOptions } = require("../utils/cookies");

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
  // Ensure a CSRF cookie is always set. SameSite/Secure come from the shared
  // session policy (None+Secure in prod) rather than a hardcoded "strict":
  // the dashboard is cross-origin, and a strict cookie is never sent on its
  // API calls, so the server-side compare below would see no cookie and reject
  // every legitimate unsafe request. The double-submit protection is preserved
  // by the VALUE match — an attacker still cannot read the token (cross-origin)
  // nor set the custom header without a CORS preflight this API would reject.
  let cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
  if (!cookieToken) {
    cookieToken = crypto.randomBytes(TOKEN_LENGTH).toString("hex");
    res.cookie(CSRF_COOKIE, cookieToken, csrfCookieOptions());
  }
  // Expose the token so a handler (system /login) can return it in the response
  // body — the only way a cross-origin dashboard, which cannot read this
  // cookie, obtains the value it must echo in the x-csrf-token header.
  res.locals.csrfToken = cookieToken;

  // Safe methods don't need CSRF checks
  if (!UNSAFE_METHODS.has(req.method)) return next();

  // Session-lifecycle endpoints are CSRF-exempt. They run BEFORE a session
  // exists (login) or explicitly tear one down (logout), and a stale auth
  // cookie left from an expired session would otherwise deadlock re-login
  // behind a CSRF check the login page cannot satisfy (it holds no session yet).
  // Login/logout CSRF is a distinct, low-severity threat — moot on a
  // single-admin deployment — and these routes carry their own strict rate
  // limiter.
  if (req.path === "/login" || req.path === "/logout") return next();

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
