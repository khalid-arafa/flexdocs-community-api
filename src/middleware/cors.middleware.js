const cors = require("cors");
const { getDocument } = require("../core/db_service");
const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
} = require("../constants");

// Cache project allowedOrigins for 5 minutes
const originsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getProjectOrigins(projectCode) {
  const cached = originsCache.get(projectCode);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.origins;

  const project = await getDocument({
    userId: systemDatabaseName,
    projectCode: systemProjectCode,
    collectionName: systemProjectCollectionName,
    query: { code: projectCode },
    select: { allowedOrigins: 1 },
  });

  const origins = project?.allowedOrigins || [];
  originsCache.set(projectCode, { origins, ts: Date.now() });
  return origins;
}

function parseSystemOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The three answers this middleware can give. They exist as named constants
// because the dangerous combination is a *pairing*, not a single value:
// `origin: true` reflects whatever Origin the browser sent, and reflecting an
// arbitrary origin together with `Access-Control-Allow-Credentials: true` is
// precisely what CORS exists to prevent — any site could then make credentialed
// calls to this API with the victim's cookies and read the responses.
//
// So a wildcard configuration is served as a REAL public API (`origin: "*"`,
// no credentials, which is also the only thing browsers accept alongside "*"),
// while credentials stay available exclusively to explicitly-listed origins.
const BASE = { optionsSuccessStatus: 200 };

// Origin is on an allowlist (or the request is not a browser's) — reflecting it
// is safe, so cookie/credentialed calls are permitted.
const ALLOW_CREDENTIALED = { ...BASE, origin: true, credentials: true };

// Wildcard / unconfigured: readable by anyone, but as an anonymous public API.
// Callers authenticate with a bearer token in a header, which is unaffected;
// only cookie-bearing (withCredentials) requests are refused by the browser.
const ALLOW_PUBLIC = { ...BASE, origin: "*", credentials: false };

const DENY = { ...BASE, origin: false, credentials: false };

// Dynamic CORS: checks origin against project or system allowlist
async function resolveCorsOptions(req, callback) {
  const origin = req.headers.origin;

  // non-browser requests (server-to-server, mobile) — always allow. No Origin
  // means no ACAO header is emitted at all, so the credentialed variant here
  // grants nothing to a browser; it only keeps the previous behaviour.
  if (!origin) return callback(null, ALLOW_CREDENTIALED);

  const isProduction = process.env.NODE_ENV === "production";

  // project routes: /projects/:projectCode/...
  const match = req.path.match(/^\/projects\/([^/]+)/);
  if (match) {
    const allowedOrigins = await getProjectOrigins(match[1]);
    // Explicitly listed beats wildcard: a project that lists "*" AND real
    // origins still gets credentials for the ones it named.
    if (allowedOrigins.includes(origin)) {
      return callback(null, ALLOW_CREDENTIALED);
    }
    // The operator's OWN origins (ALLOWED_ORIGINS) are first-party and count
    // on every route, including project ones. The dashboard is served from one
    // of them and calls /projects/:code/... with its session cookie, so
    // without this a project that lists "*" silently downgrades the dashboard
    // to an anonymous public caller: the browser refuses `Allow-Origin: *`
    // alongside credentials, and the storage/database panels fail with
    // "blocked by CORS policy" and render as empty. There is no allowed-origins
    // field in the dashboard UI either, so an operator hitting this has no way
    // to fix it short of editing the database by hand.
    //
    // This grants nothing a wildcard reflection would: these origins are named
    // explicitly in the operator's own env, never reflected from the request.
    // A literal "*" in ALLOWED_ORIGINS cannot match a real Origin header, so
    // it stays a public-API configuration rather than a credentialed one.
    if (parseSystemOrigins().includes(origin)) {
      return callback(null, ALLOW_CREDENTIALED);
    }
    if (allowedOrigins.includes("*")) {
      return callback(null, ALLOW_PUBLIC);
    }
    // in development, allow all if project hasn't configured origins yet
    if (!isProduction && allowedOrigins.length === 0) {
      return callback(null, ALLOW_PUBLIC);
    }
    return callback(null, DENY);
  }

  // system/admin routes: check ALLOWED_ORIGINS env
  const systemOrigins = parseSystemOrigins();
  if (systemOrigins.includes(origin)) {
    return callback(null, ALLOW_CREDENTIALED);
  }
  if (systemOrigins.includes("*")) {
    return callback(null, ALLOW_PUBLIC);
  }
  // In development, allow all if ALLOWED_ORIGINS is not set — still without
  // credentials. The dashboard authenticates with cookies and IS cross-origin,
  // so a dev setup that relies on that must list its origin in ALLOWED_ORIGINS
  // (setup.sh already writes one); "unset" is a convenience for public reads,
  // not a session-bearing configuration.
  if (!isProduction && systemOrigins.length === 0) {
    return callback(null, ALLOW_PUBLIC);
  }
  return callback(null, DENY);
}

const dynamicCors = cors(resolveCorsOptions);

module.exports = { dynamicCors, parseSystemOrigins, resolveCorsOptions };
