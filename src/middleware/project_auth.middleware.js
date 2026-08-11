const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
} = require("../constants");
const { getDocument } = require("../core/db_service");
const { hashProjectToken } = require("../utils/helper");

// ── Per-request project document cache ──────────────────────────────────────
//
// projectApiAuth used to hit Mongo on every single request just to load a
// document that only changes when an admin edits it (PUT rules, add/remove
// credential, delete project, ...). Under load that lookup became the
// dominant per-request cost, so the fetched document is cached in memory
// here, keyed by project code.
//
// Invalidation is primarily EXPLICIT, not time-based: every write site in
// system/projects.routes.js calls invalidateProjectCache(code) right after
// the write, so an admin's change is visible on their very next request. The
// TTL below exists only as a backstop for a write path we missed (or one
// added later that nobody wired up) — it is deliberately short so a
// forgotten invalidation call degrades into "stale for at most 30s", not
// "stale forever".
const PROJECT_CACHE_TTL_MS = 30 * 1000;
const projectCache = new Map(); // code -> { doc, expiresAt }

// Closes a narrow TOCTOU window: a request that reads the project doc from
// Mongo just before a credential rotation commits, then tries to populate the
// cache just AFTER invalidateProjectCache already ran for that write, would
// otherwise overwrite the fresh (empty) cache slot with what it fetched —
// serving stale credentials for up to PROJECT_CACHE_TTL_MS. Bumped on every
// invalidation, checked before every populate: if the generation moved while
// a fetch was in flight, that fetch's result is used for this request only
// and never cached, so the next request re-fetches instead of trusting it.
const projectCacheGeneration = new Map(); // code -> generation number

// A deep-enough clone: rebuilds every plain object/array level so a
// downstream handler that does `req.project.someField = x`, or mutates an
// array in place (push/splice on credentials, say), can never reach through
// req.project and corrupt the entry the NEXT request would read from the
// cache. ObjectId/Date leaves are returned as-is rather than cloned — nothing
// in this codebase mutates them in place, only replaces the reference, and
// replacing a reference inside a clone never touches the original.
function cloneProjectDoc(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (value instanceof ObjectId || value._bsontype === "ObjectId") return value;
  if (Array.isArray(value)) return value.map(cloneProjectDoc);
  const out = {};
  for (const key of Object.keys(value)) out[key] = cloneProjectDoc(value[key]);
  return out;
}

// Called synchronously right after every successful write to the project
// document (see system/projects.routes.js). Deleting the entry — rather than
// updating it in place — means the next request always re-fetches from Mongo
// instead of risking a second stale copy being cached from a racing request.
function invalidateProjectCache(code) {
  projectCache.delete(code);
  projectCacheGeneration.set(code, (projectCacheGeneration.get(code) || 0) + 1);
}

async function projectApiAuth(req, res, next) {
  if (!req.params.projectCode)
    return res.status(404).json({ message: "Project code not provided!" });
  // Inclusion projection: anything NOT listed here is absent from req.project,
  // whatever its value in Mongo. Every per-project feature flag must therefore
  // be listed, or it reads as `undefined` on the REST path and the feature it
  // gates is unreachable no matter what an admin sets on the document.
  //
  // That is exactly what happened to realtimePerDocCheck and manualIndexes:
  // both were added to PROJECT_UPDATABLE_FIELDS so they could be written, and
  // both were read from req.project, but neither was ever added here — so the
  // realtime per-document rule re-check could not be switched on at all, and
  // manual-index mode never suppressed auto-indexing. The socket path was
  // unaffected because socket_auth.middleware.js fetches the document with no
  // projection, which is why storageRealtimeCheck (read off socket.project)
  // worked while these two silently did not.
  const select = {
    name: 1,
    code: 1,
    isPublic: 1,
    isActive: 1,
    userId: 1,
    dbRules: 1,
    authRules: 1,
    storageRules: 1,
    credentials: 1,
    // per-project feature flags — see the note above before removing any
    realtimePerDocCheck: 1,
    storageRealtimeCheck: 1,
    manualIndexes: 1,
    realtimeChangeStreams: 1,
  };

  if (req.params.projectCode === "_system" && req.byAdmin) {
    req.project = {
      userId: systemDatabaseName,
      code: systemProjectCode,
      name: "System",
      isActive: true,
      isPublic: true,
    };
    next();
    return;
  }

  const cached = projectCache.get(req.params.projectCode);
  let project;
  if (cached && cached.expiresAt > Date.now()) {
    project = cloneProjectDoc(cached.doc);
  } else {
    if (cached) projectCache.delete(req.params.projectCode); // expired backstop entry

    const generationAtFetchStart = projectCacheGeneration.get(req.params.projectCode) || 0;
    project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.params.projectCode },
      select,
    });

    // Only successful lookups are cached — a "not found" is never memoised,
    // so a project created moments ago is visible immediately rather than
    // waiting out a negative-cache TTL.
    if (project) {
      // Skip the populate if a write invalidated this project code while the
      // fetch above was in flight — see the TOCTOU comment on
      // projectCacheGeneration. This request still uses what it fetched.
      const generationNow = projectCacheGeneration.get(req.params.projectCode) || 0;
      if (generationNow === generationAtFetchStart) {
        projectCache.set(req.params.projectCode, {
          doc: project,
          expiresAt: Date.now() + PROJECT_CACHE_TTL_MS,
        });
      }
      // req.project must never be the SAME object stored in the cache entry
      // above, or this very request mutating it (see the clone comment) would
      // corrupt the cached copy before a second request ever reads it back.
      project = cloneProjectDoc(project);
    }
  }

  if (!project) {
    return res.status(404).json({ message: "Project was not found!" });
  }

  if (!req.byAdmin && !project.isActive) {
    return res.status(404).json({ message: "Project was not found!" });
  }

  if (!req.byAdmin && !project.isPublic) {
    const publicRoutes = [
      "/login-with-email",
      "/register-with-email",
      "/login-with-token",
      "/anonymous-login",
      "/register-with-phone",
      "/send-email-verification",
      "/send-reset-password-email",
    ];

    if (!publicRoutes.includes(req.path)) {
      const projectToken = req.headers["project-token"];
      if (!projectToken)
        return res.status(404).json({ message: "This project is private!" });
      const incomingHash = hashProjectToken(projectToken);
      const incomingBuf = Buffer.from(incomingHash, "hex");
      const validToken = project.credentials.find((i) => {
        const storedHash = i.creds.projectTokenHash;
        if (!storedHash) return false;
        const storedBuf = Buffer.from(storedHash, "hex");
        return storedBuf.length === incomingBuf.length &&
          crypto.timingSafeEqual(storedBuf, incomingBuf);
      });
      if (!validToken)
        return res.status(404).json({ message: "This project is private!" });
    }
  }
  req.project = project;
  next();
}

// implement storage rules

module.exports = {
  projectApiAuth,
  invalidateProjectCache,
};
