const {
  systemDatabaseName,
  systemProjectCode,
  authCollectionName,
} = require("../constants");
const { registerWithEmailAndPassword } = require("../core/auth_service");
const { getDocument, updateDocument } = require("../core/db_service");
const { hashPassword, verifyPassword } = require("../utils/encryptions");
const Logger = require("../utils/logger");

async function createAdminUser() {
  try {
    const envEmail = process.env.ADMIN_EMAIL;
    const envPass = process.env.ADMIN_PASS;
    if (!envEmail || !envPass) return;

    const admin = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { roles: ["admin"] },
    });

    if (admin) {
      // Sync credentials with .env if they changed
      const emailChanged = admin.email !== envEmail;
      const { match: passwordMatch } = await verifyPassword(envPass, admin.password);
      if (emailChanged || !passwordMatch) {
        const updateData = {};
        if (emailChanged) updateData.email = envEmail;
        if (!passwordMatch) updateData.password = await hashPassword(envPass);
        await updateDocument({
          userId: systemDatabaseName,
          projectCode: systemProjectCode,
          collectionName: authCollectionName,
          query: { _id: admin._id },
          updateData,
        });
        Logger.info("Admin credentials synced with .env");
      }
      return;
    }

    await registerWithEmailAndPassword({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      name: "Admin",
      email: envEmail,
      password: envPass,
      roles: ["admin"],
    });
    Logger.info("Admin created!");
  } catch (error) {
    Logger.error("Failed to create admin user: " + error.message, { stack: error.stack });
  }
}

module.exports = { createAdminUser };
