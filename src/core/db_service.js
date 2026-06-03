const { ObjectId } = require("mongodb");
const Logger = require("../utils/logger");
const { getUserDB } = require("./client");
const ensureIndexes = require("./ensure_indexes");

// Operators that execute arbitrary JavaScript inside MongoDB — always forbidden.
const BLOCKED_OPERATORS = new Set(["$where", "$function", "$accumulator"]);

// Maximum time (ms) a read query is allowed to run on the MongoDB server.
const QUERY_TIMEOUT_MS = 10_000;

function formatQueryObj(query) {
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
      if (BLOCKED_OPERATORS.has(key))
        throw new Error(`Forbidden operator: ${key}`);
      result[key] = processObject(value);
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
  const db = await getUserDB(userId, projectCode);
  try {
    await db.collection(collectionName).drop();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function renameCollection({ userId, projectCode, oldName, newName }) {
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

  try {
    const result = await collection.insertOne({
      ...formatQueryObj(data),
      createdAt: new Date(),
    });
    return result.insertedId;
  } catch (error) {
    Logger.log(error.message, __filename);
    return null;
  }
}

async function getDocument({
  userId,
  projectCode,
  collectionName,
  query,
  select = {},
}) {
  try {
    if (!userId || !projectCode || !collectionName || !query)
      throw new Error("Missing required parameters");
    const db = await getUserDB(userId, projectCode);
    const collection = db.collection(collectionName);
    query = formatQueryObj(query);
    await ensureIndexes({
      collection,
      query,
      sort: {},
      canCreateIndexes: true,
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
}) {
  if (limit < 1) return [];
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  query = formatQueryObj(query);
  await ensureIndexes({ collection, query, sort, canCreateIndexes: true });
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
}) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(collectionName);
  query = formatQueryObj(query);
  await ensureIndexes({ collection, query, canCreateIndexes: true });
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
      formatQueryObj(updateData),
    );
  return await collection.updateOne(formatQueryObj(query), {
    $set: formatQueryObj(updateData),
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
    $set: formatQueryObj(updateData),
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
