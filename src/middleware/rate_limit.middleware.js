const rateLimit = require("express-rate-limit");

const AUTH_WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const API_WINDOW_MS   =  1 * 60 * 1000; //  1 minute

// Configurable via environment — fall back to generous production defaults.
const API_MAX  = parseInt(process.env.RATE_LIMIT_API_MAX,  10) || 300; // req / minute
const AUTH_MAX = parseInt(process.env.RATE_LIMIT_AUTH_MAX, 10) || 30;  // req / 15 min
const ANON_MAX = parseInt(process.env.RATE_LIMIT_ANON_MAX, 10) || 10;  // req / 15 min

// Strict limiter for auth endpoints (login, register, password reset)
const authLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

// Stricter limiter for anonymous login — prevent account-spam abuse
const anonLoginLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: ANON_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many anonymous accounts created, please try again later." },
});

// General API limiter
const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: API_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

module.exports = { authLimiter, anonLoginLimiter, apiLimiter };
