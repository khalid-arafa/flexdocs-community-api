const DbRulesService = require("../core/db_rules_service");
const Logger = require("../utils/logger");

// Storage rules reuse the same JEXL engine and path/action model as DB rules,
// so projects already familiar with DB rules get an identical mental model.
//
// Convention (top-level keys are validated by validateDbRulesStructure):
//   "/files"        — file operations:   read | add | update | delete
//   "/buckets"      — bucket operations: read | add | update | delete
//   "/files/[id]"   — per-file override
//   "/buckets/[id]" — per-bucket override
//
// Inside a rule expression the target file/bucket is exposed as `doc` and the
// caller as `user` (same context shape as DB rules). When no matching rule is
// defined the action is allowed — consistent with the DB rules default.
async function checkStorageRule({
  storageRules,
  action,
  resource,
  user = null,
  doc = null,
  body = null,
}) {
  const service = new DbRulesService(storageRules || {});
  const id = doc && doc._id ? doc._id.toString() : null;
  const path = id ? `/${resource}/${id}` : `/${resource}`;
  return service.check({ action, path, user, doc, body });
}

// Express middleware factory. `resource` is "files" or "buckets"; `loadDoc`
// (optional) returns the target document so document-level rules and ownership
// checks (e.g. doc.uploadedBy) can be evaluated.
function storageGuard(action, resource, loadDoc) {
  return async (req, res, next) => {
    try {
      // System/DB admins bypass project storage rules.
      if (req.isDbAdmin || req.byAdmin) return next();

      let doc = null;
      if (typeof loadDoc === "function") {
        doc = await loadDoc(req);
        req.storageDoc = doc; // let the handler reuse it instead of re-querying
      }

      const allowed = await checkStorageRule({
        storageRules: req.project.storageRules,
        action,
        resource,
        user: req.sender || null,
        doc,
        body: req.body || null,
      });

      if (!allowed)
        return res.status(403).json({ message: "Access denied by storage rules." });

      next();
    } catch (error) {
      Logger.error("storageGuard error: " + error.message, { stack: error.stack });
      return res.status(500).json({ message: "Internal server error" });
    }
  };
}

module.exports = { storageGuard, checkStorageRule };
