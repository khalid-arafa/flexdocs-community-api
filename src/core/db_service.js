const { ObjectId } = require("mongodb");
const Logger = require("../utils/logger");
const { AppError } = require("../utils/app_error");
const { getUserDB } = require("./client");
const ensureIndexes = require("./ensure_indexes");
const { reservedCollectionNames, authCollectionName } = require("../constants");

// Operators that execute arbitrary JavaScript inside MongoDB — always forbidden.
const BLOCKED_OPERATORS = new Set(["$where", "$function", "$accumulator"]);

// Value-coercion markers that may legitimately appear as keys in document DATA
// (formatQueryObj converts them to ObjectId/Date). Every other "$"-prefixed key
// is a MongoDB operator and must NOT appear in a stored document.
const DATA_COERCION_KEYS = new Set(["$oid", "$date"]);

// System/reserved collections that the data-plane primitives must never drop or
// rename, even if a caller forwards an unvalidated name.
const RESERVED_NAMES = new Set([...reservedCollectionNames, authCollectionName]);

// Strip MongoDB operators from a document write payload (create/update/replace
// data). The query allowlist intentionally permits operators for FILTERS, but a
// stored document is just data — an operator key there is either an injection
// attempt or a mistake. `$oid`/`$date` coercion markers are preserved.
function sanitizeWriteData(data) {
  function walk(obj) {
    if (!obj || typeof obj !== "object") return obj;
    // BSON/Date instances are leaf VALUES, not plain objects — walking them with
    // Object.entries() destroys them (ObjectId flattens to a raw buffer object,
    // Date to {}), corrupting _id fields and failing the insert downstream.
    if (obj instanceof Date || obj instanceof ObjectId || obj._bsontype === "ObjectId")
      return obj;
    if (Array.isArray(obj)) return obj.map(walk);
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      // Drop stray operator keys ($set/$inc/$rename/$gt/…) — they have no place
      // in a stored document. Keep the coercion markers ($oid/$date) and keep the
      // JS-exec operators so formatQueryObj still rejects them LOUDLY (vs silently).
      if (
        key.startsWith("$") &&
        !DATA_COERCION_KEYS.has(key) &&
        !BLOCKED_OPERATORS.has(key)
      )
        continue;
      out[key] = walk(value);
    }
    return out;
  }
  return walk(data);
}

// Maximum time (ms) a read query is allowed to run on the MongoDB server.
const QUERY_TIMEOUT_MS = 10_000;

function formatQueryObj(query) {
  function coerceIdString(value) {
    return typeof value === "string" && ObjectId.isValid(value) ? new ObjectId(value) : value;
  }

  // `_id` needs coercion wherever it appears as a key, not only when it's the
  // query's sole key (the shortcut below already covered that case) and not
  // only as a bare string. Two shapes fell through before this existed:
  //   - multi-key filters, e.g. { _id: "hex", ownerId: "x" } — the sole-key
  //     shortcut never fires because the object has two keys, so `_id`
  //     reached Mongo as a string and matched nothing against a stored
  //     ObjectId.
  //   - `_id: { $in: [...] } }` / `$nin` — array elements are plain query
  //     values, not another query object, so plain recursion never visited
  //     them as candidates for coercion.
  // Anything else under `_id` (a single-key `{ $oid }`/`{ $date }` wrapper,
  // for instance) still goes through processObject unchanged, so existing
  // shapes keep behaving exactly as before.
  function coerceIdField(value) {
    if (typeof value === "string") return coerceIdString(value);
    if (Array.isArray(value)) return value.map(coerceIdField);
    if (value && typeof value === "object") {
      if (!("$in" in value) && !("$nin" in value)) return processObject(value);
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = k === "$in" || k === "$nin" ? coerceIdField(v) : processObject(v);
      }
      return out;
    }
    return value;
  }

  function processObject(obj) {
    if (!obj || typeof obj !== "object") return obj;

    if (Array.isArray(obj)) return obj.map((item) => processObject(item));
    if (Object.keys(obj).length === 1) {
      if ("_id" in obj && ObjectId.isValid(obj._id))
        return { _id: new ObjectId(obj._id) };
      if ("$oid" in obj && ObjectId.isValid(obj.$oid))
        return new ObjectId(obj.$oid);
      if ("$date" in obj) return new Date(obj.$date);
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // AppError(400) rather than a bare Error: this is a caller mistake, not a
      // server fault, and the central error handler only masks 500-class
      // messages — so the operator name survives to the client instead of being
      // flattened into "Internal server error".
      if (BLOCKED_OPERATORS.has(key))
        throw new AppError(`Forbidden operator: ${key}`, 400);
      result[key] = key === "_id" ? coerceIdField(value) : processObject(value);
    }
    return result;
  }
  return processObject(JSON.parse(JSON.stringify(query)));
}

async function getCollectionsList({
  userId,
  projectCode,
  where = {},
  skip = 0,
  limit = 100,
}) {
  const db = await getUserDB(userId, projectCode);
  const allCollections = await db.listCollections(where).toArray();
  const collections = allCollections
    .map((i) => Object({ name: i.name }))
    .filter((i) => !i.name.startsWith("_"))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const selectedCollections = collections.slice(skip, skip + limit);

  const counts = await Promise.all(
    selectedCollections.map((col) =>
      countDocuments({ userId, projectCode, collectionName: col.name }),
    ),
  );
  for (let i = 0; i < selectedCollections.length; i++) {
    selectedCollections[i].documentsCount = counts[i];
  }

  return { collections: selectedCollections, totalCount: collections.length };
}

async function createCollection({ userId, projectCode, collectionName }) {
  const db = await getUserDB(userId, projectCode);
  try {
    collectionName = collectionName.trim();
    if (collectionName.includes(" "))
      return {
        success: false,
        error: "Collection name shoud not contain spaces",
      };
    const collectionExists = await db
      .listCollections({ name: collectionName })
      .hasNext();
    if (collectionExists)
      return {
        success: false,
        error: "Collection with this name already exists",
      };

    await db.createCollection(collectionName);
    return { success: true, data: { name: collectionName } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function checkCollectionExists({ userId, projectCode, collectionName }) {
  const db = await getUserDB(userId, projectCode);
  try {
    const collections = await db
      .listCollections({ name: collectionName })
      .toArray();
    return { success: collections.length > 0, collection: collections[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function dropCollection({ userId, projectCode, collectionName }) {
  if (RESERVED_NAMES.has(collectionName))
    return { success: false, error: "Cannot drop a system collection" };
  const db = await getUserDB(userId, projectCode);
  try {
    await db.collection(collectionName).drop();
    return { success: true };
  } catch (error) {
    // 26 = NamespaceNotFound. Dropping a collection that was never created (or
    // is already gone) leaves the caller in exactly the state it asked for, so
    // report success. DELETE /:col surfaces a failed drop as a 500 now that it
    // awaits this call, and an admin clearing an empty collection must not trip
    // that.
    if (error.code === 26) return { success: true };
    return { success: false, error: error.message };
  }
}

async function renameCollection({ userId, projectCode, oldName, newName }) {
  if (RESERVED_NAMES.has(oldName) || RESERVED_NAMES.has(newName))
    return { success: false, error: "Cannot rename to/from a system collection" };
  const db = await getUserDB(userId, projectCode);
  try {
    const exists = await db.listCollections({ name: newName }).hasNext();
    if (exists)
      return { success: false, error: "A collection with this name already exists" };
    await db.collection(oldName).rename(newName);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// C15: admin-operated index management, additive alongside auto-indexing
// (ensure_indexes.js), which stays default-on. Lets an operator who opts a
// project into project.manualIndexes (see projects.routes.js) declare
// indexes explicitly instead — snapshotting what auto-indexing already
// created is the recommended first step before flipping that flag.
async function listIndexes({ userId, projectCode, collectionName }) {
  const db = await getUserDB(userId, projectCode);
  try {
    const indexes = await db.collection(collectionName).indexes();
    return { success: true, indexes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function createIndex({ userId, projectCode, collectionName, keys, options = {} }) {
  const db = await getUserDB(userId, projectCode);
  try {
    const name = await db.collection(collectionName).createIndex(keys, options);
    return { success: true, name };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function dropIndex({ userId, projectCode, collectionName, name }) {
  if (name === "_id_")
    return { success: false, error: "Cannot drop the default _id_ index" };
  const db = await getUserDB(userId, projectCode);
  try {
    await db.collection(collectionName).dropIndex(name);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function dropDatabase({ userId, projectCode }) {
  try {
    const db = await getUserDB(userId, projectCode);
    await db.dropDatabase();
    return { success: true };
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return { success: false, error: error.message };
  }
}

//
async function createDocument({ userId, projectCode, collectionName, data }) {
  const db = await getUserDB(userId, projectCode);
  try {
    await db.createCollection(collectionName);
  } catch (err) {
    if (err.code !== 48) throw err; // 48 = NamespaceExists — safe to ignore
  }
  const collection = db.collection(collectionName);

  // Deliberately NOT wrapped in a try/catch. Swallowing the failure and
  // returning null made every caller report a success for a document that was
  // never stored — the /add route answered 200 {_id: null} and emitted a
  // realtime "add" event for a phantom document. Callers decide how a failed
  // insert should surface; duplicate-key (11000) in particular is a client
  // error, not a server fault.
  const result = await collection.insertOne({
    ...formatQueryObj(sanitizeWriteData(data)),
    createdAt: new Date(),
  });
  return result.insertedId;
}

async function getDocument({
  userId,
  projectCode,
  collectionName,
  query,
  select = {},
  // C15: defaults to true so every existing call site (the overwhelming
  // majority, which has no reason to know about a per-project flag) keeps
  // today's auto-indexing behavior unchanged. Only db.routes.js's request
  // handlers, which have req.project in scope, ever pass this explicitly.
  canCreateIndexes = true,
}) {
  try {
    if (!userId || !projectCode || !collectionName || !query)
      throw new Error("Missing required parameters");
    const db = await getUserDB(userId, projectCode);
    const collection = db.collection(collectionName);
    query = formatQueryObj(query);
    // Guard against an all-undefined query collapsing to {} and matching the
    // FIRST document (a single-document lookup must never become match-all).
    if (
      query &&
      typeof query === "object" &&
      !Array.isArray(query) &&
      Object.keys(query).length === 0
    )
      return null;
    await ensureIndexes({
      collection,
      query,
      sort: {},
      canCreateIndexes,
    });
    return await collection.findOne(query, { projection: select, maxTimeMS: QUERY_TIMEOUT_MS });
  } catch (error) {
    Logger.log(error.message, __filename);
    return null;
  }
}

async function getManyDocuments({
  userId,
  projectCode,
  collectionName,
  query = {},
  sort = {},
  skip = 0,
  select = {},
  limit = 100,
  canCreateIndexes = true,
}) {
  if (limit < 1) return [];
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  query = formatQueryObj(query);
  await ensureIndexes({ collection, query, sort, canCreateIndexes });
  return await collection
    .find(query)
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .project(select)
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .toArray();
}

async function countDocuments({
  userId,
  projectCode,
  collectionName,
  query = {},
  canCreateIndexes = true,
}) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  query = formatQueryObj(query);
  await ensureIndexes({ collection, query, canCreateIndexes });
  return await collection.countDocuments(query, { maxTimeMS: QUERY_TIMEOUT_MS });
}

async function updateDocument({
  userId,
  projectCode,
  collectionName,
  query,
  updateData,
  type = "update",
}) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  if (type === "replace")
    return await collection.replaceOne(
      formatQueryObj(query),
      formatQueryObj(sanitizeWriteData(updateData)),
    );
  return await collection.updateOne(formatQueryObj(query), {
    $set: formatQueryObj(sanitizeWriteData(updateData)),
  });
}

async function updateManyDocuments(
  userId,
  projectCode,
  collectionName,
  filter,
  updateData,
) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  return await collection.updateMany(formatQueryObj(filter), {
    $set: formatQueryObj(sanitizeWriteData(updateData)),
  });
}

async function deleteDocument({ userId, projectCode, collectionName, query }) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  return await collection.deleteOne(formatQueryObj(query));
}

async function deleteManyDocuments({
  userId,
  projectCode,
  collectionName,
  query,
}) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  return await collection.deleteMany(formatQueryObj(query));
}

module.exports = {
  sanitizeWriteData,
  formatQueryObj,
  listIndexes,
  createIndex,
  dropIndex,
  createCollection,
  getCollectionsList,
  checkCollectionExists,
  dropCollection,
  renameCollection,
  dropDatabase,
  createDocument,
  getDocument,
  getManyDocuments,
  countDocuments,
  updateDocument,
  updateManyDocuments,
  deleteDocument,
  deleteManyDocuments,
};
