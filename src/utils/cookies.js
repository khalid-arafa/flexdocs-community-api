// Shared cookie policy for the browser session (admin dashboard).
//
// The dashboard is served from a DIFFERENT origin than this API, so the browser
// only attaches these cookies to the dashboard's cross-origin API calls when
// SameSite=None — which the cookie spec permits ONLY alongside Secure. In
// production (HTTPS) that is exactly what we emit. In local dev over plain HTTP
// a Secure cookie would be dropped by the browser, so we fall back to Lax and
// the dashboard authenticates over the Authorization: Bearer path instead (both
// the auth middlewares already accept `cookie || Bearer`).
//
// `secure` keys off NODE_ENV to match the existing CSRF cookie (csrf.middleware)
// rather than req.secure, so the whole session shares one consistent policy and
// there is no per-request drift behind the nginx TLS terminator.

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function sameSitePolicy() {
  const secure = process.env.NODE_ENV === "production";
  return { sameSite: secure ? "none" : "lax", secure };
}

// httpOnly session cookies — the JWT lives here, unreadable to JavaScript (and
// therefore to any XSS). maxAge tracks the token's 30d expiry so cookie and
// token lapse together.
function authCookieOptions() {
  return {
    httpOnly: true,
    ...sameSitePolicy(),
    path: "/",
    maxAge: THIRTY_DAYS_MS,
  };
}

// The double-submit CSRF cookie. httpOnly:false because a SAME-origin client
// must read it to echo the header; a cross-origin dashboard cannot read it at
// all and instead receives the value in the login response body. Same
// SameSite/Secure as the session so it rides the same cross-origin requests and
// is actually present for the server-side compare.
function csrfCookieOptions() {
  return {
    httpOnly: false,
    ...sameSitePolicy(),
    path: "/",
    maxAge: THIRTY_DAYS_MS,
  };
}

// clearCookie only removes a cookie when path + sameSite + secure match what
// was set — otherwise the browser keeps the original.
function clearedAuthCookieOptions() {
  return { httpOnly: true, ...sameSitePolicy(), path: "/" };
}

module.exports = {
  sameSitePolicy,
  authCookieOptions,
  csrfCookieOptions,
  clearedAuthCookieOptions,
};
