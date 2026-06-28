const express = require("express");
const {
  loginWithEmailAndPassword,
  registerWithEmailAndPassword,
  loginWithToken,
  anonymousLogin,
  changePassword,
  sendVerifyEmail,
  sendResetPasswordEmail,
} = require("../core/auth_service");
const { authCollectionName, defaultAuthRules } = require("../constants");
const {
  getManyDocuments,
  countDocuments,
  updateDocument,
  getDocument,
  deleteDocument,
} = require("../core/db_service");

const { sendAuthSocketEvent } = require("../sockets/auth.sockets.js");
const { hashPassword } = require("../utils/encryptions.js");
const { isStrongPassword, isValidEmail } = require("../utils/validators.js");
const { checkDbUserApiAuth } = require("../middleware/user_auth.middleware.js");
const { getPublicBaseUrl } = require("../utils/helper.js");
const { authLimiter, anonLoginLimiter } = require("../middleware/rate_limit.middleware.js");
const { zodValidate } = require("../middleware/zod_validate.middleware.js");
const Logger = require("../utils/logger");
const {
  dbRegisterSchema,
  dbLoginSchema,
  dbTokenLoginSchema,
  dbAnonymousLoginSchema,
  dbChangePasswordSchema,
  adminListAccountsSchema,
  adminAddAccountSchema,
} = require("../utils/schemas.js");

const router = express.Router();

function getAuthRule(project, ruleName) {
  const rules = project.authRules || defaultAuthRules;
  return rules[ruleName] !== undefined ? rules[ruleName] : defaultAuthRules[ruleName];
}

router.post("/register-with-email", authLimiter, zodValidate(dbRegisterSchema), async (req, res) => {
  if (!getAuthRule(req.project, "allowEmailRegistration"))
    return res.status(403).json({ message: "Email registration is currently disabled." });
  const { email, password } = req.body;
  if (getAuthRule(req.project, "requireStrongPassword") && !isStrongPassword(password))
    return res.status(400).json({
      message: "Password must be 8+ chars with upper, lower, number & symbol.",
    });
  try {
    const user = await registerWithEmailAndPassword({
      userId: req.project.userId,
      projectCode: req.project.code,
      ...req.body,
    });
    sendAuthSocketEvent({
      projectCode: req.project.code,
      action: "add",
      data: [user],
    });
    // auto-send verification email when requireEmailVerification is enabled
    if (getAuthRule(req.project, "requireEmailVerification") && email) {
      sendVerifyEmail({
        project: req.project,
        email,
        baseUrl: `${getPublicBaseUrl(req)}/verify?token=`,
      }).catch(() => {});
    }
    return res.status(200).json(user);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.post("/login-with-email", authLimiter, zodValidate(dbLoginSchema), async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await loginWithEmailAndPassword({
      userId: req.project.userId,
      projectCode: req.project.code,
      email,
      password,
    });
    if (getAuthRule(req.project, "requireEmailVerification") && !user.emailVerified)
      return res.status(403).json({
        message: "Please verify your email address before logging in.",
      });
    return res.status(200).json(user);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.post("/login-with-token", authLimiter, zodValidate(dbTokenLoginSchema), async (req, res) => {
  try {
    const user = await loginWithToken(
      req.project.userId,
      req.project.code,
      req.body.token,
    );
    return res.status(200).json(user);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.post("/anonymous-login", anonLoginLimiter, zodValidate(dbAnonymousLoginSchema), async (req, res) => {
  if (!getAuthRule(req.project, "allowAnonymousLogin"))
    return res.status(403).json({ message: "Anonymous login is currently disabled." });
  try {
    const user = await anonymousLogin(
      req.project.userId,
      req.project.code,
      req.body,
    );
    sendAuthSocketEvent({
      projectCode: req.project.code,
      action: "add",
      data: [user],
    });
    return res.status(200).json(user);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.post("/register-with-phone", async (req, res) => {
  return res.status(200).json({ message: "Not implemented yet!" });
});

// change password
router.post("/change-password", authLimiter, checkDbUserApiAuth, zodValidate(dbChangePasswordSchema), async (req, res) => {
  try {
    if (!req.sender) throw new Error("No token was provided");

    const { oldPassword, newPassword } = req.body;
    const result = await changePassword({
      projectCode: req.project.code,
      userId: req.project.userId,
      accountId: req.sender._id,
      oldPassword,
      newPassword,
    });

    res.status(200).json({ success: result.modifiedCount > 0 });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.get("/send-email-verification", authLimiter, checkDbUserApiAuth, async (req, res) => {
  if (!getAuthRule(req.project, "allowEmailVerification"))
    return res.status(403).json({ message: "Email verification is currently disabled." });
  try {
    if (!req.sender) throw new Error("No authentication token provided");

    const account = await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query: { _id: req.sender._id.toString() },
      select: { email: 1 },
    });

    if (!account) throw new Error("Account couldn't be found!");

    if (!isValidEmail(account.email)) throw new Error("Email is invalid");

    const success = await sendVerifyEmail({
      project: req.project,
      email: account.email,
      baseUrl: `${getPublicBaseUrl(req)}/verify?token=`,
    });
    if (!success)
      throw new Error(
        "A problem has happened while sending the verification email!",
      );
    return res
      .status(200)
      .json({ message: "A verification link was sent to your email!" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/send-reset-password-email", authLimiter, async (req, res) => {
  if (!getAuthRule(req.project, "allowPasswordReset"))
    return res.status(403).json({ message: "Password reset is currently disabled." });
  try {
    if (!req.body.email) throw new Error("Email is required");
    if (!isValidEmail(req.body.email)) throw new Error("Email is invalid");

    await sendResetPasswordEmail({
      project: req.project,
      email: req.body.email,
      baseUrl: `${getPublicBaseUrl(req)}/reset-password?token=`,
    });

    return res.status(200).json({
      message:
        "If your email is registered, a reset password email was sent to it!",
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// admin
const adminAuth = (req, res, next) => {
  if (!req.byAdmin)
    return res.status(403).json({ message: "Sorry admins only!" });
  next();
};
router.use(adminAuth);

router.post("/accounts", zodValidate(adminListAccountsSchema), async (req, res) => {
  let { query, sort, select, limit, page } = req.body;
  if (!page) page = 1;
  if (!limit) limit = 100;
  if (!sort) sort = { createdAt: -1 };
  const skip = (page - 1) * limit;
  try {
    const accounts = await getManyDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query,
      sort,
      select,
      limit,
      skip,
    });
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      account.uid = account._id.toString();
    }
    const totalCount = await countDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query,
    });
    return res.status(201).json({
      accounts,
      totalCount,
      page,
      ipp: limit,
    });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.post("/accounts/add", zodValidate(adminAddAccountSchema), async (req, res) => {
  try {
    const user = await registerWithEmailAndPassword({
      userId: req.project.userId,
      projectCode: req.project.code,
      ...req.body,
    });
    const account = await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query: { _id: user.uid },
    });
    sendAuthSocketEvent({
      projectCode: req.project.code,
      action: "add",
      data: [{ ...account, uid: account._id.toString() }],
    });
    return res.status(200).json(user);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.post("/accounts/send-verification-email", async (req, res) => {
  try {
    let { userId: accountId } = req.body;
    const account = await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query: { _id: accountId },
      select: { email: 1 },
    });

    if (!account) throw new Error("Account couldn't be found!");
    if (!isValidEmail(account.email)) throw new Error("Email is invalid");

    const success = await sendVerifyEmail({
      project: req.project,
      email: account.email,
      baseUrl: `${getPublicBaseUrl(req)}/verify?token=`,
    });
    if (!success)
      throw new Error(
        "A problem has happened while sending the verification email!",
      );
    return res
      .status(200)
      .json({ message: "A verification link was sent to your email!" });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.put("/accounts/:id", async (req, res) => {
  try {
    if (req.body.password && req.byAdmin) {
      req.body.password = await hashPassword(req.body.password);
    }
    const result = await updateDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query: { _id: req.params.id },
      type: "update",
      updateData: req.body,
    });
    const account = await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query: { _id: req.params.id },
    });
    sendAuthSocketEvent({
      projectCode: req.project.code,
      action: "update",
      data: [{ ...account, uid: account._id.toString() }],
    });
    return res.status(200).json({ success: result.matchedCount });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.delete("/accounts/:id", async (req, res) => {
  try {
    const query = { _id: req.params.id };
    const result = await deleteDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: authCollectionName,
      query: query,
    });
    sendAuthSocketEvent({
      projectCode: req.project.code,
      action: "delete",
      data: [query],
    });
    return res.status(200).json({ success: result.deletedCount });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
