const jexl = require("jexl");
const Logger = require("../utils/logger");

const JEXL_TIMEOUT_MS = 100;

// Wraps jexl.eval with a hard timeout to prevent hanging on complex expressions.
// On timeout the rule is treated as a deny (returns false via the caller's catch).
function evalWithTimeout(expression, context) {
  return Promise.race([
    jexl.eval(expression, context),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`JEXL evaluation timed out after ${JEXL_TIMEOUT_MS}ms`)),
        JEXL_TIMEOUT_MS,
      )
    ),
  ]);
}

class DbRulesService {
  constructor(rules) {
    this.rules = rules || {};
  }

  // 🔹 New check function
  async check({ action, path, user, body, doc }) {
    try {
      if (doc) {
        const allowed = await this.isDocumentAllowed({
          path,
          action,
          user,
          doc,
          body,
        });
        return Boolean(allowed);
      } else {
        const allowed = await this.isCollectionAllowed({
          path,
          action,
          user,
          doc,
          body,
        });
        return Boolean(allowed);
      }
    } catch (err) {
      Logger.error("DbRulesService check error: " + err.message, { stack: err.stack });
      return false;
    }
  }

  async isCollectionAllowed({ path, action, user, doc, body }) {
    try {
      if (!path || typeof path !== "string") return false;
      const pathParts = path.split("/").filter(Boolean);
      if (pathParts.length < 1) return false; // expect /projectCode/colName

      const collectionPath = "/" + pathParts[0]; // colName
      const result = await this._evaluateRule(
        collectionPath,
        action,
        user,
        doc,
        body
      );
      return Boolean(result);
    } catch (error) {
      Logger.error("Error evaluating collection rule: " + error.message, { stack: error.stack });
      return false;
    }
  }

  async isDocumentAllowed({ path, action, user, doc, body }) {
    try {
      if (!path || typeof path !== "string") return false;
      const pathParts = path.split("/").filter(Boolean);
      if (pathParts.length < 2) return false; // expect /colName/docId

      const collectionPath = "/" + pathParts[0];
      const docId = pathParts[1];
      const specificDocPath = collectionPath + "/" + docId;
      const dynamicDocPath = collectionPath + "/[id]";

      let result = false;
      if (this.rules.hasOwnProperty(specificDocPath)) {
        result = await this._evaluateRule(
          specificDocPath,
          action,
          user,
          doc,
          body
        );
      } else if (this.rules.hasOwnProperty(dynamicDocPath)) {
        result = await this._evaluateRule(
          dynamicDocPath,
          action,
          user,
          doc,
          body
        );
      } else {
        result = await this._evaluateRule(
          collectionPath,
          action,
          user,
          doc,
          body
        );
      }
      return Boolean(result);
    } catch (error) {
      Logger.error("Error evaluating document rule: " + error.message, { stack: error.stack });
      return false;
    }
  }

  async _evaluateRule(rulePath, action, user, doc, body) {
    const pathRule = this.rules[rulePath];
    if (typeof pathRule === "undefined") return true;
    let rule;

    if (typeof pathRule === "boolean" || typeof pathRule === "string") {
      rule = pathRule;
    } else if (
      typeof pathRule === "object" &&
      pathRule.hasOwnProperty(action)
    ) {
      rule = pathRule[action];
    } else {
      return true;
    }

    if (typeof rule === "boolean") {
      return rule;
    }

    if (typeof rule === "string") {
      const context = Object.freeze(Object.assign(Object.create(null), {
        user: user || null,
        doc: doc || null,
        body: body || null,
      }));
      try {
        const result = await evalWithTimeout(rule, context);
        return Boolean(result);
      } catch (error) {
        Logger.error("JEXL evaluation error: " + error.message, { stack: error.stack });
        return false;
      }
    }

    return false;
  }

  middleware(options = {}) {
    const {
      getUser = (req) => req.user || null,
      getDoc = (req) => req.doc || null,
      getAction = (req) => this.getAction(req),
      onUnauthorized = (req, res) =>
        res.status(403).json({
          error:
            "Access denied. You do not have permission to perform this action based on current database rules",
        }),
    } = options;

    return async (req, res, next) => {
      try {
        const user = getUser(req);
        const doc = getDoc(req);
        const action = getAction(req);
        const path = req.originalUrl.split(
          `/projects/${req.project.code}/db`
        )[1];
        const body = req.body || null;
        let allowed = false;
        if (doc) {
          allowed = await this.isDocumentAllowed({
            path,
            action,
            user,
            doc,
            body,
          });
        } else {
          allowed = await this.isCollectionAllowed({
            path,
            action,
            user,
            doc,
            body,
          });
        }

        if (allowed) {
          next();
        } else {
          onUnauthorized(req, res);
        }
      } catch (error) {
        Logger.error("DbRulesService middleware error: " + error.message, { stack: error.stack });
        res.status(500).json({ error: "Internal server error" });
      }
    };
  }

  setRules(rules) {
    this.rules = rules || {};
  }

  getRules() {
    return this.rules;
  }

  addPathRules(path, pathRules) {
    this.rules[path] = pathRules;
  }

  getAction(req) {
    const method = req.method.toLowerCase();
    const path = req.originalUrl.split(`/projects/${req.project.code}/db`)[1];
    if (method === "post" && !/\/[^/]+\/[^/]+$/.test(path)) return "read";
    if (method === "get" && /\/[^/]+\/[^/]+$/.test(path)) return "read";
    if (method === "post" && path.endsWith("/add")) return "add";
    if (method === "put") return "update";
    if (method === "delete") return "delete";
    return "read";
  }
}

module.exports = DbRulesService;
