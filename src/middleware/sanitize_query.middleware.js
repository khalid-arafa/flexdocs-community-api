// MongoDB query sanitization - strips dangerous operators from user-supplied queries
// Allows safe query operators while blocking code execution vectors

const ALLOWED_OPERATORS = new Set([
  // comparison
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  // logical
  "$and", "$or", "$not", "$nor",
  // element
  "$exists", "$type",
  // array
  "$all", "$elemMatch", "$size",
  // evaluation (safe subset)
  "$regex", "$options", "$mod",
  // update operators (used in updateDocument paths)
  "$set", "$unset", "$inc", "$push", "$pull", "$addToSet", "$pop", "$rename",
]);

// $regex runs inside the database, but the cost lands on a single shared Node
// process via a blocked connection and maxTimeMS does not reliably interrupt
// regex evaluation. Bound the input instead.
const MAX_REGEX_LENGTH = 250;

// $and/$or/$nor nest arbitrarily, so a small payload can describe a very large
// boolean tree. Depth is capped well above any realistic query.
const MAX_QUERY_DEPTH = 12;

/**
 * Rejects a query the caller is not allowed to run. Distinct from operator
 * stripping: an unsafe value is refused outright rather than silently dropped,
 * so the caller learns their filter did not apply.
 */
class UnsafeQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeQueryError";
  }
}

// Catastrophic backtracking needs a quantified group whose body can match the
// same input more than one way. Two shapes cover the practical cases:
//   - a quantifier inside a quantified group:  (a+)+   (a*)*
//   - an alternation inside a quantified group: (a|aa)+
//
// This is a conservative heuristic, not a proof of safety: deciding whether an
// arbitrary pattern is exponential is not worth doing at request time. It errs
// toward rejection, which is acceptable because database filters rarely need
// either shape, and the caller gets an explicit 400 rather than a stalled
// request. The length cap above is the backstop for whatever slips through.
const REDOS_SHAPES = [
  /\([^)]*[+*}][^)]*\)\s*[+*{]/, // quantifier nested in a quantified group
  /\([^)]*\|[^)]*\)\s*[+*{]/, // alternation in a quantified group
];

function assertSafeRegex(pattern) {
  if (typeof pattern !== "string") {
    throw new UnsafeQueryError("$regex must be a string");
  }
  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new UnsafeQueryError(
      `$regex must be at most ${MAX_REGEX_LENGTH} characters`,
    );
  }
  if (REDOS_SHAPES.some((shape) => shape.test(pattern))) {
    throw new UnsafeQueryError(
      "$regex contains a quantified group that risks catastrophic backtracking",
    );
  }
}

function sanitizeObject(obj, depth = 0) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (depth > MAX_QUERY_DEPTH) {
    throw new UnsafeQueryError(
      `Query nesting exceeds ${MAX_QUERY_DEPTH} levels`,
    );
  }

  if (Array.isArray(obj)) return obj.map((item) => sanitizeObject(item, depth + 1));

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    // block any $ operator not in the allowlist
    if (key.startsWith("$") && !ALLOWED_OPERATORS.has(key)) continue;
    if (key === "$regex") assertSafeRegex(value);
    cleaned[key] = sanitizeObject(value, depth + 1);
  }
  return cleaned;
}

// Express middleware: sanitizes req.body.query, req.body.filter, req.body.sort
function sanitizeQuery(req, res, next) {
  try {
    if (req.body) {
      if (req.body.query) req.body.query = sanitizeObject(req.body.query);
      if (req.body.filter) req.body.filter = sanitizeObject(req.body.filter);
      if (req.body.sort) req.body.sort = sanitizeObject(req.body.sort);
      if (req.body.where) req.body.where = sanitizeObject(req.body.where);
    }
  } catch (error) {
    if (error instanceof UnsafeQueryError) {
      return res.status(400).json({ message: error.message });
    }
    throw error;
  }
  next();
}

module.exports = {
  sanitizeQuery,
  sanitizeObject,
  UnsafeQueryError,
  MAX_REGEX_LENGTH,
  MAX_QUERY_DEPTH,
};
