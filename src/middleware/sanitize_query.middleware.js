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

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    // block any $ operator not in the allowlist
    if (key.startsWith("$") && !ALLOWED_OPERATORS.has(key)) continue;
    cleaned[key] = sanitizeObject(value);
  }
  return cleaned;
}

// Express middleware: sanitizes req.body.query, req.body.filter, req.body.sort
function sanitizeQuery(req, res, next) {
  if (req.body) {
    if (req.body.query) req.body.query = sanitizeObject(req.body.query);
    if (req.body.filter) req.body.filter = sanitizeObject(req.body.filter);
    if (req.body.sort) req.body.sort = sanitizeObject(req.body.sort);
    if (req.body.where) req.body.where = sanitizeObject(req.body.where);
  }
  next();
}

module.exports = { sanitizeQuery, sanitizeObject };
