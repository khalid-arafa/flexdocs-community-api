const { MongoClient } = require("mongodb");
const { systemDatabaseName } = require("../constants");
const Logger = require("../utils/logger");
require("dotenv").config();

const clientOptions = {
  maxPoolSize: 100,
  minPoolSize: 10,
  maxIdleTimeMS: 30000,
  connectTimeoutMS: 10000,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
};

const DatabaseClient = new MongoClient(process.env.MONGODB_URI, clientOptions);

// Connect once at startup and reuse (cached promise prevents concurrent connect races)
let connectPromise = null;
async function connectToMongo() {
  if (!connectPromise) {
    connectPromise = DatabaseClient.connect()
      .then(() => Logger.info("Connected to MongoDB"))
      .catch((err) => {
        connectPromise = null; // allow retry on next call
        Logger.error("Failed to connect to MongoDB", { error: err.message, stack: err.stack });
        throw err;
      });
  }
  return connectPromise;
}

async function getUserDB(userId, projectCode) {
  try {
    await connectToMongo(); // Ensure connected before accessing DB
    if (!userId || !projectCode) throw new Error("Could not get the Db");
    const dbCode =
      userId === systemDatabaseName ? systemDatabaseName : `${projectCode}`;
    return DatabaseClient.db(dbCode);
  } catch (error) {
    Logger.error("getUserDB failed: " + error.message, { stack: error.stack });
    throw error;
  }
}

/**
 * Ensure critical unique indexes exist on system collections.
 * Called once at startup after the DB connection is established.
 * Drops and recreates an index if its specs have changed.
 */
async function ensureCriticalIndexes() {
  const {
    systemProjectCollectionName,
    authCollectionName,
  } = require("../constants");

  const systemDb = DatabaseClient.db(systemDatabaseName);

  async function safeCreateIndex(collection, key, options) {
    try {
      await collection.createIndex(key, options);
    } catch (err) {
      if (err.code === 86 /* IndexKeySpecsConflict */) {
        await collection.dropIndex(options.name || Object.keys(key).map(k => `${k}_${key[k]}`).join("_"));
        await collection.createIndex(key, options);
      } else {
        throw err;
      }
    }
  }

  // Unique project code in the system projects collection
  await safeCreateIndex(
    systemDb.collection(systemProjectCollectionName),
    { code: 1 },
    { unique: true },
  );

  // System admin accounts: unique email
  await safeCreateIndex(
    systemDb.collection(authCollectionName),
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $exists: true } } },
  );
}

module.exports = {
  DatabaseClient,
  getUserDB,
  ensureCriticalIndexes,
};
