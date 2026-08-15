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
//
// This is the ONLY place the driver's connect() is called. index.js used to
// call DatabaseClient.connect() directly at boot, which worked purely because
// the driver's connect is idempotent — but it meant two independent paths to
// the same state, only one of which logged, and only one of which reset itself
// so a later caller could retry.
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

// Boot-time retry budget. Mongo and the API are routinely started together
// (docker compose, a host reboot), so "connection refused" at t=0 is normal
// and temporary; "still refused a minute later" is not. Retrying beyond the
// budget is pointless — the supervisor restarting the container is the better
// recovery, and it also re-reads configuration a stuck process never would.
const BOOT_CONNECT_BUDGET_MS = Number(process.env.BOOT_DB_TIMEOUT_MS) || 60000;
const BOOT_CONNECT_BASE_DELAY_MS = 1000;
const BOOT_CONNECT_MAX_DELAY_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect at startup, retrying with backoff until the budget is spent.
 *
 * The retry lives HERE and not inside connectToMongo() on purpose: request-path
 * callers (getUserDB) must fail fast on a dead Mongo rather than each hold a
 * request open for the whole boot budget. connectToMongo() keeps its single
 * job — connect once, cache the result, clear the cache on failure so the next
 * call genuinely retries — and this loop is simply a caller that makes use of
 * that. Each attempt already carries the driver's serverSelectionTimeoutMS
 * (10s), so the delays below are the pause BETWEEN attempts, not the pace of
 * them; the budget is checked after an attempt fails, so at least one full
 * attempt always happens however small the budget.
 *
 * Rejects with the last error once the budget is exhausted. The caller decides
 * what that means — index.js treats it as fatal.
 */
async function connectWithRetry({
  budgetMs = BOOT_CONNECT_BUDGET_MS,
  baseDelayMs = BOOT_CONNECT_BASE_DELAY_MS,
  maxDelayMs = BOOT_CONNECT_MAX_DELAY_MS,
} = {}) {
  const deadline = Date.now() + budgetMs;
  let delay = baseDelayMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await connectToMongo();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      Logger.warn(
        `MongoDB not reachable (attempt ${attempt}); retrying in ${delay}ms`,
        { error: error.message },
      );
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
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
  connectToMongo,
  connectWithRetry,
};
