const express = require("express");
const router = express.Router();
const fs = require("fs");

const {
  getDocument,
  getManyDocuments,
  deleteDocument,
  dropDatabase,
  countDocuments,
} = require("../core/db_service");
const constants = require("../constants");
const Logger = require("../utils/logger");

const { sendAuthSocketEvent } = require("../sockets/auth.sockets");

const { systemApiAuth } = require("../middleware/system_auth.middleware");
router.use(systemApiAuth);

// Writes a structured audit entry to the log stream.
// Never throws — a logging failure must not block the response.
function auditLog(req, action, details = {}) {
  try {
    Logger.info("AUDIT", {
      action,
      adminId: req.sender?._id?.toString() ?? "unknown",
      adminEmail: req.sender?.email ?? "unknown",
      ip: req.ip,
      requestId: req.id,
      ...details,
      timestamp: new Date().toISOString(),
    });
  } catch (_) {
    // intentionally swallowed
  }
}

router.use((req, res, next) => {
  if (!req.byAdmin)
    return res.status(403).json({
      message: "Access denied, You're not authorized to access this route.",
    });
  next();
});

router.post("/projects", async (req, res) => {
  let { page, ipp, select, query, sort } = req.body;
  if (!page) page = 1;
  if (!ipp) ipp = 20;

  try {
    const projects = await getManyDocuments({
      userId: constants.systemDatabaseName,
      projectCode: constants.systemProjectCode,
      collectionName: constants.systemProjectCollectionName,
      query,
      limit: ipp,
      skip: (page - 1) * ipp,
      select,
      sort,
    });

    const totalCount = await countDocuments({
      userId: constants.systemDatabaseName,
      projectCode: constants.systemProjectCode,
      collectionName: constants.systemProjectCollectionName,
      query,
    });

    return res.status(200).json({
      projects,
      page,
      ipp,
      totalCount,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.get("/accounts/:id", async (req, res) => {
  try {
    const user = await getDocument({
      userId: constants.systemDatabaseName,
      projectCode: constants.systemProjectCode,
      collectionName: constants.authCollectionName,
      query: { _id: req.params.id },
      // Never return secrets/auth-state (matches /me and checkDbUserApiAuth).
      select: {
        password: 0,
        resetPasswordToken: 0,
        failedLoginAttempts: 0,
        lockedUntil: 0,
      },
    });
    if (!user) return res.status(404).json({ message: "couldn't find user" });
    return res.status(200).json(user);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.delete("/accounts/:id", systemApiAuth, async (req, res) => {
  auditLog(req, "admin_delete_account", { targetAccountId: req.params.id });
  try {
    const userresult = await deleteDocument({
      userId: constants.systemDatabaseName,
      projectCode: constants.systemProjectCode,
      collectionName: constants.authCollectionName,
      query: { _id: req.params.id },
    });
    const projects = await getManyDocuments({
      userId: constants.systemDatabaseName,
      projectCode: constants.systemProjectCode,
      collectionName: constants.systemProjectCollectionName,
      query: { userId: { $oid: req.params.id } },
    });
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const result = await deleteDocument({
        userId: constants.systemDatabaseName,
        projectCode: constants.systemProjectCode,
        collectionName: constants.systemProjectCollectionName,
        query: { code: project.code },
      });
      if (result.deletedCount) {
        await dropDatabase({
          userId: project.userId,
          projectCode: project.code,
        });
        fs.rmSync(`${constants.uploadsPath}/${project.code}`, {
          recursive: true,
          force: true,
        });
      }
    }
    sendAuthSocketEvent({
      projectCode: constants.systemProjectCode,
      action: "delete",
      data: [{ _id: req.params.id }],
    });
    return res.status(200).json({ success: true });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
