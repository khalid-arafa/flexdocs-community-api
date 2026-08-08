const {
  authCollectionName,
  reservedCollectionNames,
  systemDatabaseName,
  systemProjectCode,
} = require("../constants");
const DbRulesService = require("../core/db_rules_service");
const { getDocument, getManyDocuments, countDocuments } = require("../core/db_service");
const { verifyToken } = require("../utils/encryptions");
const Logger = require("../utils/logger");

// Maximum number of documents a single non-admin bulk update/delete may touch.
// Bounds memory and guarantees every affected document is rule-checked, so a
// wide filter can't silently bypass per-document rules on docs we never loaded.
const BULK_RULE_CHECK_LIMIT = 1000;

function validateCollectionParam(req, res) {
  const col = req.params.col;
  if (col && reservedCollectionNames.includes(col)) {
    res.status(400).json({ message: "Sorry, you cannot use system collections!" });
    return false;
  }
  if (col && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(col)) {
    res.status(400).json({
      message: "Invalid collection name. Must start with a letter, alphanumeric and underscore only, max 64 chars.",
    });
    return false;
  }
  return true;
}

module.exports.validateCollectionParam = validateCollectionParam;

module.exports.collectionMiddleware = (req, res, next) => {
  if (!validateCollectionParam(req, res)) return;
  if (req.isDbAdmin || req.byAdmin) return next();
  const service = new DbRulesService(req.project.dbRules);
  const middleware = service.middleware({
    getAction: (req) => service.getAction(req),
    getUser: (req) => req.sender || null,
  });
  return middleware(req, res, next);
};

module.exports.documentMiddleware = async (req, res, next) => {
  if (!validateCollectionParam(req, res)) return;
  if (req.isDbAdmin || req.byAdmin) return next();

  // Fetched once, here, and stashed on req.document so the GET/DELETE
  // /:col/:id handlers can reuse it instead of re-fetching the same _id right
  // after this middleware ran. This also has to be resolved BEFORE we hand
  // getDoc to DbRulesService.middleware(): that helper reads getDoc(req)
  // synchronously (see its default `getDoc = (req) => req.doc || null`), so
  // an async getDoc there would race the rule check against an unresolved
  // promise instead of the real document. Fetching up front avoids that.
  try {
    req.document = await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      query: { _id: req.params.id },
    });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }

  const service = new DbRulesService(req.project.dbRules);
  const middleware = service.middleware({
    getAction: (req) => service.getAction(req),
    getUser: (req) => req.sender || {},
    getDoc: (req) => req.document,
  });
  return middleware(req, res, next);
};

// Bulk update (PUT /:col) and bulk delete (DELETE /:col).
// Evaluates DB rules against EVERY matched document so document-level rules
// (e.g. "user.uid == doc.ownerId") are enforced on collection-wide operations.
// Previously these routes used a separate validator that only saw the request
// body, so per-document rules were silently skipped for bulk ops.
module.exports.bulkMiddleware = async (req, res, next) => {
  if (!validateCollectionParam(req, res)) return;
  if (req.isDbAdmin || req.byAdmin) return next();

  try {
    const service = new DbRulesService(req.project.dbRules);
    const action = req.method.toLowerCase() === "put" ? "update" : "delete";
    const filter = (req.body && req.body.filter) || {};

    const matched = await countDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      query: filter,
    });

    // Nothing matches — the operation is a no-op, so there is nothing to guard.
    if (matched === 0) return next();

    if (matched > BULK_RULE_CHECK_LIMIT) {
      return res.status(400).json({
        message: `This operation affects too many documents (${matched}). Refine your filter to ${BULK_RULE_CHECK_LIMIT} or fewer.`,
      });
    }

    const docs = await getManyDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      query: filter,
      limit: BULK_RULE_CHECK_LIMIT,
    });

    for (const doc of docs) {
      const allowed = await service.check({
        action,
        path: `/${req.params.col}/${doc._id}`,
        user: req.sender || null,
        doc,
        body: req.body || null,
      });
      if (!allowed) {
        return res.status(403).json({
          message:
            "Access denied. You do not have permission to modify one or more of the matched documents based on current database rules.",
        });
      }
    }

    next();
  } catch (error) {
    Logger.error("bulkMiddleware error: " + error.message, { stack: error.stack });
    return res.status(500).json({ message: "Internal server error" });
  }
};

//

//

// sockets
//

// Pure admin-identification check for a socket, factored out of
// socketAdminGuard so it can also gate socketColGuard/socketDocGuard below.
//
// This is the socket-side equivalent of REST's `req.isDbAdmin || req.byAdmin`
// (see collectionMiddleware/documentMiddleware above): a way to ask "is this
// caller the admin dashboard" without going through a specific event's guard.
// It exists because the dashboard's realtime watches (watch-col-updates,
// watch-doc) carry NO ordinary user identity by any path — the dashboard
// sends handshake.auth = { projectToken, token }, but socketAuth
// (socket_auth.middleware.js) only ever reads handshake.auth.userToken, a key
// the dashboard never sends. So socket.sender is always undefined for these
// events regardless of project, and running them through DbRulesService with
// user=null against a default-deny project silently breaks the dashboard's
// live view. Only genuinely-admin sockets should bypass rules at all — this
// function is how callers find out.
//
// Deliberately side-effect-free: no emit, no next(), no mutation of `socket`.
// Returns the resolved SYSTEM auth sender when the token is valid, active,
// admin/superadmin, and owns the socket's project; null in every other case
// (missing token, expired/invalid token, wrong role, wrong project, or any
// lookup error — all fail closed to "not admin").
//
// Cheap for ordinary SDK clients: they never populate handshake.auth.token
// (only projectToken/userToken), so this short-circuits before touching the
// DB.
async function isAdminSocket(socket) {
  try {
    const { projectToken, token } = socket.handshake.auth || {};
    if (!projectToken || !token) return null;

    const decoded = verifyToken(token);
    if (!decoded || decoded.expired) return null;

    const sender = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: decoded.userId },
    });

    const isAdmin =
      sender &&
      sender.isActive !== false &&
      Array.isArray(sender.roles) &&
      sender.roles.some((r) => r === "admin" || r === "superadmin");
    if (!isAdmin) return null;

    // Ownership: the admin must own the project being streamed. Single-admin
    // deployments always match; this is defense-in-depth for multi-admin setups.
    if (
      socket.project.code !== systemProjectCode &&
      socket.project.userId &&
      sender._id.toString() !== socket.project.userId.toString()
    ) {
      return null;
    }

    return sender;
  } catch (error) {
    Logger.error("isAdminSocket error: " + error.message, { stack: error.stack });
    return null;
  }
}
module.exports.isAdminSocket = isAdminSocket;

module.exports.socketDocGuard = async (socket, data, next) => {
  // Admin bypass, mirroring documentMiddleware's `req.isDbAdmin || req.byAdmin`
  // on the REST side (see top of file). Without this, the admin dashboard's
  // watch-doc on a normal project runs full dbRules with user=null and only
  // ever worked by relying on rules permissive enough to allow a null user —
  // this ADDS access for genuine admin sockets, it closes nothing.
  if (await isAdminSocket(socket)) return next();

  const service = new DbRulesService(socket.project.dbRules);
  const ok = await service.check({
    action: "read",
    path: data.path,
    user: socket.sender,
    doc: await getDocument({
      userId: socket.project.userId,
      projectCode: socket.project.code,
      collectionName: data.path.split("/")[1],
      query: { _id: data.path.split("/")[2] },
    }),
  });
  if (!ok) return socket.emit("error", "Unauthorized");
  next();
};

module.exports.socketColGuard = async (socket, colName, next) => {
  // Same admin bypass as socketDocGuard above — see its comment.
  if (await isAdminSocket(socket)) return next();

  const service = new DbRulesService(socket.project.dbRules);
  const ok = await service.check({
    action: "read",
    path: "/" + colName,
    user: socket.sender,
    doc: null,
  });
  if (!ok) return socket.emit("error", "Unauthorized");
  next();
};

// Guard for admin/dashboard streams (watch-collections, watch-accounts).
//
// FAIL-CLOSED: previously the user token was looked up in the *project's* auth
// collection, where a system admin never exists, so `sender` was always null and
// the guard fell through to next() — any socket with a valid project token plus
// ANY valid JWT (even an anonymous or another project's user token) passed.
//
// The dashboard authenticates with the SYSTEM admin JWT (signed project:_system),
// so we verify the token against the SYSTEM accounts collection and require an
// admin/superadmin role, plus ownership of the watched project. The actual
// verification lives in isAdminSocket() above (shared with the bypass in
// socketColGuard/socketDocGuard); this wrapper only owns the emit/next control
// flow and the more specific "Missing token or project token" message for the
// cheap pre-check, so existing callers (watch-collections, watch-accounts) see
// no behavior change from the extraction.
module.exports.socketAdminGuard = async (socket, next) => {
  const { projectToken, token } = socket.handshake.auth || {};
  if (!projectToken || !token) {
    return socket.emit("error", "Missing token or project token");
  }

  const sender = await isAdminSocket(socket);
  if (!sender) return socket.emit("error", "Unauthorized");

  socket.sender = sender;
  next();
};
