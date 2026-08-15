/**
 * Per-test-file access to the real MongoDB started by global_setup.js.
 *
 * The whole point of this suite is that NOTHING here is mocked: `dbService`
 * below is the genuine src/core/db_service, talking to the genuine
 * src/core/client, talking to a genuine mongod.
 *
 * Isolation is per *file*: each file picks its own projectCode, and
 * getUserDB(userId, projectCode) maps that straight to a MongoDB database name,
 * so two files can never see each other's documents even under --runInBand.
 */

const { MongoClient } = require("mongodb");

const SKIPPED = process.env.FLEXDOCS_IT_SKIP === "1";
const HAS_REPLICA_SET = process.env.FLEXDOCS_IT_REPLSET === "1";
const SKIP_REASON = process.env.FLEXDOCS_IT_SKIP_REASON || "no MongoDB available";

/**
 * Use in place of `describe` at the top of every integration file. Collapses to
 * describe.skip when no mongod was provisioned, so the suite reports "skipped"
 * instead of erroring out on connection failures.
 */
const describeIntegration = SKIPPED ? describe.skip : describe;

/** For assertions that need transactions or change streams. */
const describeReplicaSet = SKIPPED || !HAS_REPLICA_SET ? describe.skip : describe;

// Any truthy value that is NOT the reserved "_system" name, so getUserDB()
// routes to the per-project database rather than the system one.
const TEST_USER_ID = "integration-test-user";

/**
 * A database name unique to the calling test file.
 * MongoDB database names are limited to 63 bytes and may not contain /\. "$*<>:|?
 */
function projectCodeFor(tag) {
  return `ittest_${String(tag).replace(/[^a-zA-Z0-9_]/g, "_")}`.slice(0, 60);
}

/**
 * A raw driver client, independent of src/core/client, for setting up fixtures
 * and for verifying what is ACTUALLY stored — a test that both writes and reads
 * through the code under test can't detect a symmetric bug.
 */
let rawClient = null;
async function getRawClient() {
  if (!rawClient) {
    rawClient = new MongoClient(process.env.FLEXDOCS_IT_URI || process.env.MONGODB_URI);
    await rawClient.connect();
  }
  return rawClient;
}

async function rawDb(projectCode) {
  return (await getRawClient()).db(projectCode);
}

/** Drops the file's database so each run starts from nothing. */
async function resetDb(projectCode) {
  const db = await rawDb(projectCode);
  await db.dropDatabase();
}

/**
 * Closes every connection this file opened, including the application's shared
 * client, so Jest exits without --forceExit and without open-handle warnings.
 */
async function closeConnections() {
  if (rawClient) {
    await rawClient.close(true);
    rawClient = null;
  }
  try {
    // Lazily required: importing src/core/client at module scope would build a
    // MongoClient even in the skipped case, where MONGODB_URI may be unset.
    const { DatabaseClient } = require("../../../core/client");
    await DatabaseClient.close(true);
  } catch {
    // Never loaded (or already closed) — nothing to release.
  }
}

/** Inserts fixtures with the raw driver, bypassing all code under test. */
async function seed(projectCode, collectionName, docs) {
  const db = await rawDb(projectCode);
  await db.collection(collectionName).insertMany(docs);
  return docs;
}

module.exports = {
  describeIntegration,
  describeReplicaSet,
  projectCodeFor,
  TEST_USER_ID,
  SKIPPED,
  HAS_REPLICA_SET,
  SKIP_REASON,
  getRawClient,
  rawDb,
  resetDb,
  closeConnections,
  seed,
};