const {
  systemDatabaseName,
  systemProjectCode,
  setupLockCollectionName,
  SETUP_LOCK_ID,
} = require("../constants");
const { getUserDB } = require("../core/client");
const Logger = require("./logger");

// The one-time claim on creating the first administrator.
//
// Two things create that admin: the setup wizard (POST /setup) and the
// ADMIN_EMAIL/ADMIN_PASS seed. Both used the same check-then-create shape —
// count admins, see zero, create one — and both can run at the same time:
// index.js calls createAdminUser() WITHOUT awaiting it and then listens, so the
// seed is still running while the first requests are already being served.
// Two concurrent callers therefore both read zero and both create an admin, and
// because their emails differ the unique index on `email` does not stop it.
//
// A read cannot fix a race between two readers, so the claim is a write: insert
// a document with a FIXED _id. Exactly one insert wins; the rest raise
// duplicate-key (11000). This is the same trick the credential check uses —
// let the database be the authority instead of hoping the window stays narrow.
//
// A caller that wins and then FAILS must release, or a rejected password on the
// very first setup attempt would lock the system out of ever creating an admin.
async function claimSetupSlot() {
  const db = await getUserDB(systemDatabaseName, systemProjectCode);
  try {
    await db
      .collection(setupLockCollectionName)
      .insertOne({ _id: SETUP_LOCK_ID, claimedAt: new Date() });
    return true;
  } catch (error) {
    if (error && error.code === 11000) return false;
    throw error;
  }
}

async function releaseSetupSlot() {
  try {
    const db = await getUserDB(systemDatabaseName, systemProjectCode);
    await db
      .collection(setupLockCollectionName)
      .deleteOne({ _id: SETUP_LOCK_ID });
  } catch (error) {
    Logger.error("Failed to release the setup slot: " + error.message);
  }
}

module.exports = { claimSetupSlot, releaseSetupSlot };
