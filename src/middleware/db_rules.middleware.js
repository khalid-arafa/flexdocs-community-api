const { authCollectionName, reservedCollectionNames } = require("../constants");
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

module.exports.documentMiddleware = (req, res, next) => {
  if (!validateCollectionParam(req, res)) return;
  if (req.isDbAdmin || req.byAdmin) return next();
  const service = new DbRulesService(req.project.dbRules);
  const middleware = service.middleware({
    getAction: (req) => service.getAction(req),
    getUser: (req) => req.sender || {},
    getDoc: async (req) =>
      await getDocument({
        userId: req.project.userId,
        projectCode: req.project.code,
        collectionName: req.params.col,
        query: { _id: req.params.id },
      }),
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
module.exports.socketDocGuard = async (socket, data, next) => {
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

module.exports.socketAdminGuard = async (socket, next) => {
  const { projectToken, token } = socket.handshake.auth;

  // console.log({ token, projectToken });

  if (!projectToken || !token) {
    socket.emit("error", "Missing token or project token");
    return;
  }

  const decodedUserToken = verifyToken(token);
  if (!decodedUserToken) return;
  const sender = await getDocument({
    userId: socket.project.userId,
    projectCode: socket.project.code,
    collectionName: authCollectionName,
    // tokens are signed as { userId, project } — match that field, not _id
    query: { _id: decodedUserToken.userId },
  });
  socket.sender = sender;

  // if (socket.sender?._id.toString() != socket.project.userId.toString()) {
  //   socket.emit("error", "Auth user not found");
  //   return;
  // }

  next();
};
