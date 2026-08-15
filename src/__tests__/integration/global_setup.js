/**
 * Jest globalSetup for the integration suite.
 *
 * Boots ONE real mongod for the whole run and publishes its URI through
 * process.env, which Jest copies into every worker. That matters because
 * src/core/client.js builds its MongoClient from process.env.MONGODB_URI at
 * MODULE LOAD time — setting it here is the only way the real client ends up
 * pointed at the test server without editing src/.
 *
 * When no mongod can be provisioned this does NOT fail. It sets a skip flag the
 * test files read, so a machine with no network, no Docker and no local mongod
 * still finishes green with a loud explanation.
 */

const { startMongoForTests } = require("../helpers/mongo_test_server");

module.exports = async function globalSetup() {
  const server = await startMongoForTests();

  if (!server) {
    process.env.FLEXDOCS_IT_SKIP = "1";
    process.env.FLEXDOCS_IT_SKIP_REASON =
      "no MongoDB available (tried MONGODB_TEST_URI, mongodb-memory-server, docker, local mongod)";
    // eslint-disable-next-line no-console
    console.warn(
      [
        "",
        "  ┌─────────────────────────────────────────────────────────────────┐",
        "  │  INTEGRATION SUITE SKIPPED — no real MongoDB available          │",
        "  └─────────────────────────────────────────────────────────────────┘",
        "  Provide one of:",
        "    • MONGODB_TEST_URI=mongodb://host:port  (any reachable mongod)",
        "    • network access so mongodb-memory-server can fetch mongod",
        "    • a working docker daemon (pulls " +
          (process.env.MONGODB_TEST_DOCKER_IMAGE || "mongo:7") +
          ")",
        "    • a local mongod on 127.0.0.1:27017",
        "",
      ].join("\n"),
    );
    return;
  }

  // Point the application's own client at the test server.
  process.env.MONGODB_URI = server.uri;
  process.env.FLEXDOCS_IT_URI = server.uri;
  process.env.FLEXDOCS_IT_STRATEGY = server.strategy;
  process.env.FLEXDOCS_IT_REPLSET = server.replicaSet ? "1" : "0";
  delete process.env.FLEXDOCS_IT_SKIP;

  // Handed to globalTeardown, which runs in this same process.
  globalThis.__FLEXDOCS_MONGO__ = server;

  // eslint-disable-next-line no-console
  console.log(
    `\n  Integration MongoDB ready via "${server.strategy}"` +
      ` (replica set: ${server.replicaSet ? "yes — transactions + change streams enabled" : "no"})\n`,
  );
};
