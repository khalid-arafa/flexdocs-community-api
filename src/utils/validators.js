const Jexl = require("jexl");

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return /^\+?\d{1,3}?[-.\s]?\(?\d{1,4}?\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}$/.test(
    phone,
  );
}

function isStrongPassword(password) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/.test(password);
}

// NOTE: an earlier rule evaluator (`dbRulesValidator`) lived here and defaulted
// to *allow* when no rule path matched. It was superseded by
// core/db_rules_service.js, which is default-deny. It was removed rather than
// left exported, because wiring it back up would silently reintroduce fail-open
// authorization. Rule evaluation belongs in DbRulesService only.

const { defaultAuthRules } = require("../constants");

/**
 * Validates database rules structure before storage.
 * Rules must be an object where:
 *   - Each key is a path string (e.g. "/collectionName" or "/collectionName/[id]")
 *   - Each value is boolean, JEXL string, or an object with action keys
 * Returns { valid: boolean, errors: string[] }
 */
function validateDbRulesStructure(rules) {
  if (rules === null || rules === undefined) return { valid: true, errors: [] };
  if (typeof rules !== "object" || Array.isArray(rules)) {
    return { valid: false, errors: ["Rules must be a plain object"] };
  }

  const errors = [];
  const validActions = new Set(["read", "add", "update", "delete"]);
  const pathPattern = /^\/[a-zA-Z0-9_-]+(\/((\[[a-zA-Z0-9_]+\])|[a-f0-9]{24}))?$/;
  const jexl = Jexl;

  for (const [path, rule] of Object.entries(rules)) {
    if (!pathPattern.test(path)) {
      errors.push(`Invalid rule path: "${path}". Must match /collectionName or /collectionName/[id]`);
      continue;
    }

    if (typeof rule === "boolean") continue;

    if (typeof rule === "string") {
      try {
        jexl.compile(rule);
      } catch (e) {
        errors.push(`Invalid JEXL expression at "${path}": ${e.message}`);
      }
      continue;
    }

    if (typeof rule === "object" && !Array.isArray(rule)) {
      for (const [action, value] of Object.entries(rule)) {
        if (!validActions.has(action)) {
          errors.push(`Unknown action "${action}" at path "${path}". Valid: read, add, update, delete`);
          continue;
        }
        if (typeof value === "boolean") continue;
        if (typeof value === "string") {
          try {
            jexl.compile(value);
          } catch (e) {
            errors.push(`Invalid JEXL expression at "${path}.${action}": ${e.message}`);
          }
          continue;
        }
        errors.push(`Rule value at "${path}.${action}" must be boolean or JEXL string, got ${typeof value}`);
      }
      continue;
    }

    errors.push(`Rule at "${path}" must be boolean, string, or object with action keys`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates auth rules: only known boolean keys from defaultAuthRules.
 * Returns { valid: boolean, errors: string[] }
 */
function validateAuthRules(rules) {
  if (rules === null || rules === undefined) return { valid: true, errors: [] };
  if (typeof rules !== "object" || Array.isArray(rules)) {
    return { valid: false, errors: ["Auth rules must be a plain object"] };
  }

  const errors = [];
  const validKeys = Object.keys(defaultAuthRules);

  for (const [key, value] of Object.entries(rules)) {
    if (!validKeys.includes(key)) {
      errors.push(`Unknown auth rule: "${key}". Valid: ${validKeys.join(", ")}`);
    }
    if (typeof value !== "boolean") {
      errors.push(`Auth rule "${key}" must be a boolean`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  isValidEmail,
  isValidPhone,
  isStrongPassword,
  validateDbRulesStructure,
  validateAuthRules,
};
