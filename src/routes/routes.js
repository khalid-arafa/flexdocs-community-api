const express = require("express");
const router = express.Router();

const { projectApiAuth } = require("../middleware/project_auth.middleware");
const { checkDbUserApiAuth } = require("../middleware/user_auth.middleware");
const { checkSystemApiAuth } = require("../middleware/system_auth.middleware");
const { authLimiter } = require("../middleware/rate_limit.middleware");

// test connection
router.get("/:projectCode/test-connection", projectApiAuth, (_, res) =>
  res.status(200).json({ connected: true }),
);

// auth (stricter rate limit)
router.use(
  "/:projectCode/auth",
  authLimiter,
  checkSystemApiAuth,
  projectApiAuth,
  require("./auth.routes"),
);

// db
router.use(
  "/:projectCode/db",
  checkSystemApiAuth,
  projectApiAuth,
  checkDbUserApiAuth,
  require("./db.routes"),
);

// storage
router.use(
  "/:projectCode/storage",
  checkSystemApiAuth,
  projectApiAuth,
  checkDbUserApiAuth,
  require("./storage.routes"),
);

module.exports = router;
