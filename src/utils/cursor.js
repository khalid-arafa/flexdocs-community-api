const { ObjectId } = require("mongodb");

// C11: opt-in keyset ("cursor") pagination for POST /:col, additive alongside
// the existing page/skip offset pagination — offset stays the default and is
// completely untouched when no cursor param is sent.
//
// The cursor token itself is unsigned base64url JSON: `{ id, f?, v? }` where
// `id` is the last returned document's _id and `f`/`v` (present unless the
// sort field IS _id) are the sort field's name and value on that document.
// It never needs signing — everything it can express is already reachable
// through the ordinary `query`/`sort` params on this same route, which the
// caller was already authorized (by dbRules) to send directly.

function serializeCursorValue(value) {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof ObjectId || (value && value._bsontype === "ObjectId"))
    return { $oid: value.toString() };
  return value;
}

function encodeCursor(lastDoc, sortField) {
  if (!lastDoc || !lastDoc._id) return null;
  const payload = { id: lastDoc._id.toString() };
  if (sortField && sortField !== "_id") {
    payload.f = sortField;
    payload.v = serializeCursorValue(lastDoc[sortField]);
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursorStr) {
  try {
    const payload = JSON.parse(Buffer.from(cursorStr, "base64url").toString("utf8"));
    if (!payload || typeof payload.id !== "string" || !ObjectId.isValid(payload.id))
      return null;
    return payload;
  } catch {
    return null;
  }
}

// Builds the seek condition and a normalized (single-field + _id tiebreaker)
// sort for keyset pagination. Only the requested sort's first key is used as
// the primary field, matching this route's existing single-field assumption.
// `_id` is always appended as a tiebreaker so pagination stays deterministic
// even when the primary field has duplicate values across documents.
function buildCursorSeek({ query, sort, cursorStr }) {
  const [primaryField, primaryDirRaw] = Object.entries(sort || {})[0] || ["_id", 1];
  const primaryDir = primaryDirRaw === -1 ? -1 : 1;
  const effectiveSort =
    primaryField === "_id" ? { _id: primaryDir } : { [primaryField]: primaryDir, _id: primaryDir };

  if (!cursorStr) return { query, sort: effectiveSort, primaryField };

  const cursor = decodeCursor(cursorStr);
  if (!cursor) return { query, sort: effectiveSort, primaryField, invalidCursor: true };

  const op = primaryDir === -1 ? "$lt" : "$gt";
  const seek =
    primaryField === "_id"
      ? { _id: { [op]: { $oid: cursor.id } } }
      : {
          $or: [
            { [primaryField]: { [op]: cursor.v } },
            { [primaryField]: cursor.v, _id: { [op]: { $oid: cursor.id } } },
          ],
        };

  const mergedQuery = query && Object.keys(query).length ? { $and: [query, seek] } : seek;
  return { query: mergedQuery, sort: effectiveSort, primaryField };
}

module.exports = { encodeCursor, decodeCursor, buildCursorSeek };
