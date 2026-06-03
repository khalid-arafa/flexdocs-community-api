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

// Dynamic CORS: checks origin against project or system allowlist
const dynamicCors = cors(async (req, callback) => {
  const origin = req.headers.origin;
  const opts = { credentials: true, optionsSuccessStatus: 200 };

  // non-browser requests (server-to-server, mobile) — always allow
  if (!origin) return callback(null, { ...opts, origin: true });

  const isProduction = process.env.NODE_ENV === "production";

  // project routes: /projects/:projectCode/...
  const match = req.path.match(/^\/projects\/([^/]+)/);
  if (match) {
    const allowedOrigins = await getProjectOrigins(match[1]);
    if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return callback(null, { ...opts, origin: true });
    }
    // in development, allow all if project hasn't configured origins yet
    if (!isProduction && allowedOrigins.length === 0) {
      return callback(null, { ...opts, origin: true });
    }
    return callback(null, { ...opts, origin: false });
  }

  // system/admin routes: check ALLOWED_ORIGINS env
  const systemOrigins = parseSystemOrigins();
  if (systemOrigins.includes("*") || systemOrigins.includes(origin)) {
    return callback(null, { ...opts, origin: true });
  }
  // in development, allow all if ALLOWED_ORIGINS is not set
  if (!isProduction && systemOrigins.length === 0) {
    return callback(null, { ...opts, origin: true });
  }
  return callback(null, { ...opts, origin: false });
});

module.exports = { dynamicCors, parseSystemOrigins };
