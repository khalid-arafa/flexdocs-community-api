/**
 * Integration suite — runs the real src/core/db_service against a real mongod.
 *
 * Deliberately separate from the unit config in package.json (which now ignores
 * src/__tests__/integration/), so `npm test` keeps its existing meaning and
 * speed. Run this one with `npm run test:integration`.
 */

module.exports = {
  testEnvironment: "node",
  rootDir: __dirname,
  roots: ["<rootDir>/src/__tests__/integration"],
  testMatch: ["**/*.test.js"],
  setupFiles: ["<rootDir>/src/__tests__/helpers/setup.js"],
  globalSetup: "<rootDir>/src/__tests__/integration/global_setup.js",
  globalTeardown: "<rootDir>/src/__tests__/integration/global_teardown.js",

  // Serial: the suite shares one mongod and several modules under test hold
  // process-wide state (ensure_indexes' index cache, client.js's connect
  // promise). Parallel workers would make index assertions racy.
  maxWorkers: 1,

  // A cold mongodb-memory-server run downloads ~120MB of mongod first.
  testTimeout: 120_000,

  clearMocks: true,
};
