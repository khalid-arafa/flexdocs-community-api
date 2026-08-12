const express = require("express");
const router = express.Router();
const { loginWithEmailAndPassword } = require("../core/auth_service");
const { systemApiAuth } = require("../middleware/system_auth.middleware");
const {
  getDocument,
  countDocuments,
  updateDocument,
  getManyDocuments,
  deleteDocument,
  dropDatabase,
} = require("../core/db_service");
const {
  systemDatabaseName,
  systemProjectCode,
  authCollectionName,
  systemProjectCollectionName,
  uploadsPath,
  authCookieNames,
} = require("../constants");
const { hashPassword, verifyPassword } = require("../utils/encryptions");
const {
  authCookieOptions,
  clearedAuthCookieOptions,
} = require("../utils/cookies");
const { authLimiter } = require("../middleware/rate_limit.middleware");
const { zodValidate } = require("../middleware/zod_validate.middleware");
const {
  systemLoginSchema,
  systemProfileUpdateSchema,
} = require("../utils/schemas");
const { isStrongPassword } = require("../utils/validators");
const fs = require("fs");
const Logger = require("../utils/logger");

// NOTE: public system signup (POST /register) has been removed. This is a
// single-admin deployment — the sole admin is created once via the first-run
// /setup wizard (see src/routes/setup.routes.js) or seeded from ADMIN_EMAIL/
// ADMIN_PASS. There is intentionally no route to create additional system users.

router.post("/login", authLimiter, zodValidate(systemLoginSchema), async (req, res) => {
  try {
    const user = await loginWithEmailAndPassword({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      ...req.body,
    });
    // Establish the session as httpOnly cookies so the browser holds the JWT
    // somewhere JavaScript — and therefore any XSS on the dashboard — cannot
    // read it. Set under BOTH names the middlewares read: `flexdocs-auth-token`
    // gates the system routes (/me, /admin, /settings, /my/projects) and
    // `db-auth-token` is what checkSystemApiAuth recognises on the project
    // routes, so an admin keeps their elevated access while browsing project
    // data (and file downloads carry it, bypassing the ?token= requirement).
    if (user && user.token) {
      res.cookie(authCookieNames.system, user.token, authCookieOptions());
      res.cookie(authCookieNames.dbUser, user.token, authCookieOptions());
    }
    // The token still rides the JSON body: in local dev over plain HTTP the
    // cross-site cookie cannot be set (SameSite=None needs Secure), so the
    // dashboard falls back to the Authorization: Bearer path there. `csrfToken`
    // lets the cross-origin dashboard — which cannot read this API's CSRF
    // cookie — echo the double-submit value on unsafe requests (csrf.middleware).
    return res.status(200).json({ ...user, csrfToken: res.locals.csrfToken });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});

// Server-side session teardown: the session cookies are httpOnly, so only the
// server can clear them. clearCookie must use the SAME options the cookies were
// set with (path + sameSite + secure) or the browser keeps them. Deliberately
// unauthenticated and idempotent — logging out must succeed even with an
// already-expired or missing session, and it reveals nothing.
router.post("/logout", (req, res) => {
  res.clearCookie(authCookieNames.system, clearedAuthCookieOptions());
  res.clearCookie(authCookieNames.dbUser, clearedAuthCookieOptions());
  return res.status(200).json({ success: true });
});

router.get("/me", systemApiAuth, async (req, res) => {
  try {
    const user = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: req.sender._id },
      // Never return secrets/auth-state to the client.
      select: {
        password: 0,
        resetPasswordToken: 0,
        failedLoginAttempts: 0,
        lockedUntil: 0,
      },
    });
    if (!user)
      return res.status(400).json({ message: "User couldn't be found!" });
    return res.status(200).json(user);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.put("/me", systemApiAuth, zodValidate(systemProfileUpdateSchema), async (req, res) => {
  const { name, phone, email, password, oldPassword } = req.body;
  try {
    const user = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: req.sender._id },
    });
    if (!user)
      return res.status(400).json({ message: "User couldn't be found!" });
    delete user._id;

    if (password) {
      if (!oldPassword)
        return res.status(400).json({ message: "Old password is required!" });
      const { match } = await verifyPassword(oldPassword, user.password);
      if (!match)
        return res.status(400).json({ message: "Old password is incorrect!" });
      if (!isStrongPassword(password))
        return res.status(400).json({
          message:
            "Password is very weak, try harder one with at least, one capital letter, small letters and a symbol",
        });
      user.password = await hashPassword(password);
    }

    if (name) user.name = name;
    if (email) {
      if (user.email && email != user.email) {
        const emailExists = await countDocuments({
          userId: systemDatabaseName,
          projectCode: systemProjectCode,
          collectionName: authCollectionName,
          query: { email },
        });
        if (emailExists)
          return res.status(400).json({ message: "Email already exists!" });
      }
      user.email = email;
    }
    if (phone) {
      if (user.phone && phone != user.phone) {
        const phoneExists = await countDocuments({
          userId: systemDatabaseName,
          projectCode: systemProjectCode,
          collectionName: authCollectionName,
          query: { phone },
        });
        if (phoneExists)
          return res
            .status(400)
            .json({ message: "Phone number already exists!" });
      }
      user.phone = phone;
    }

    const result = await updateDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: req.sender._id },
      updateData: user,
      type: "update",
    });

    return res.status(200).json({ success: result.matchedCount == 1 });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});

//
router.delete("/me", systemApiAuth, async (req, res) => {
  try {
    await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: req.sender._id },
    });
    await deleteDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: req.sender._id },
    });
    const projects = await getManyDocuments({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { userId: { $oid: req.sender._id } },
    });
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const result = await deleteDocument({
        userId: systemDatabaseName,
        projectCode: systemProjectCode,
        collectionName: systemProjectCollectionName,
        query: { code: project.code },
      });
      if (result.deletedCount) {
        await dropDatabase({
          userId: project.userId,
          projectCode: project.code,
        });
        await fs.promises.rm(`${uploadsPath}/${project.code}`, {
          recursive: true,
          force: true,
        });
      }
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.use("/my/projects", require("./projects.routes"));
router.use("/admin", require("./admin.routes"));
router.use("/settings", require("./settings.routes"));

module.exports = router;
