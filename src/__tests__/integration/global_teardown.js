/**
 * Jest globalTeardown for the integration suite — stops whatever globalSetup
 * started. Runs in the same process, so the handle is still on globalThis.
 */

module.exports = async function globalTeardown() {
  const server = globalThis.__FLEXDOCS_MONGO__;
  if (!server) return;
  try {
    await server.stop();
  } catch (err) {
    // Never fail the run on cleanup; a leaked container/binary is a nuisance,
    // not a test result.
    // eslint-disable-next-line no-console
    console.warn(`  Integration MongoDB teardown warning: ${err.message}`);
  } finally {
    delete globalThis.__FLEXDOCS_MONGO__;
  }
};
