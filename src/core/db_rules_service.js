const jexl = require("jexl");
const Logger = require("../utils/logger");

const JEXL_TIMEOUT_MS = 100;

// jexl.eval() re-parses the expression string into an AST on every call. Rules
// are a small fixed set of strings evaluated on every authorized request, so
// that parse is pure repeated work — roughly 10x the cost of the evaluation
// itself. Compile once and reuse the AST.
//
// Bounded even though rules are operator-authored and few: the cache is keyed
// by string, and an unbounded string-keyed cache on a request path is a memory
// DoS waiting for the day rules become user-supplied.
const MAX_COMPILED_EXPRESSIONS = 500;
const compiledExpressions = new Map();

function getCompiledExpression(expression) {
  const cached = compiledExpressions.get(expression);
  if (cached) return cached;

  // Throws on a syntax error; callers evaluate inside a try that denies.
  const compiled = jexl.compile(expression);
  if (compiledExpressions.size >= MAX_COMPILED_EXPRESSIONS) {
    compiledExpressions.delete(compiledExpressions.keys().next().value);
  }
  compiledExpressions.set(expression, compiled);
  return compiled;
}

// Wraps evaluation with a hard timeout to prevent hanging on complex
// expressions. On timeout the rule is treated as a deny (via the caller's
// catch). The timer is cleared once the race settles: leaving it pending kept
// an active timer per evaluation for the full window, which on a busy process
// meant thousands of live timers and a delayed shutdown.
function evalWithTimeout(expression, context) {
  const compiled = getCompiledExpression(expression);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`JEXL evaluation timed out after ${JEXL_TIMEOUT_MS}ms`)),
      JEXL_TIMEOUT_MS,
    );
  });
  return Promise.race([compiled.eval(context), timeout]).finally(() =>
    clearTimeout(timer),
  );
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
    // Default-DENY: when no rule is defined for this path the action is rejected.
    // Firebase/Supabase behave the same way so a freshly created, un-ruled
    // collection is never world-accessible. Operators must opt in explicitly.
    if (typeof pathRule === "undefined") return false;
    let rule;

    if (typeof pathRule === "boolean" || typeof pathRule === "string") {
      rule = pathRule;
    } else if (
      typeof pathRule === "object" &&
      pathRule.hasOwnProperty(action)
    ) {
      rule = pathRule[action];
    } else {
      // Rule object exists but does not define this action → deny.
      return false;
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
