const express = require("express");
const crypto = require("crypto");
const Logger = require("../utils/logger");
const { verifyVerificationToken } = require("../core/verification_service");
const { updateDocument, getDocument } = require("../core/db_service");

const fs = require("fs");
const path = require("path");

const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
  authCollectionName,
} = require("../constants");
const { isStrongPassword } = require("../utils/validators");
const { hashPassword } = require("../utils/encryptions");
const { authLimiter } = require("../middleware/rate_limit.middleware");
const router = express.Router();

// These three carry credential-bearing tokens, so they belong on the strict
// limiter with the rest of the auth surface. They are mounted at "/" rather
// than under /projects/:code/auth, which is the only reason they were left on
// the 300/min global limiter — an oversight, not a decision. 30 per 15 min per
// IP is far above what clicking a link from an inbox costs.
router.get("/verify", authLimiter, async (req, res) => {
  try {
    if (!req.query.token) throw new Error("Token is required");

    const result = verifyVerificationToken(req.query.token);
    if (!result.success) throw new Error(result.message);

    // Token type-confusion guard. All three verification tokens are signed with
    // the same secret and carry the same shape, so without this a
    // reset-password-link/-action token could be replayed here to mark an email
    // verified — proving ownership of an address the holder never received mail
    // at. Only a token minted by sendVerifyEmail may verify an address.
    if (result.data.type !== "email")
      throw new Error("Your token is invalid!");

    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: result.data.projectCode },
      select: { code: 1, userId: 1 },
    });

    if (!project)
      throw new Error(
        "The project you're registered in is no longer available!",
      );

    await updateDocument({
      userId: project.userId,
      projectCode: project.code,
      collectionName: authCollectionName,
      query: { _id: result.data.accountId },
      updateData: { emailVerified: true },
    });

    return res.sendFile(
      path.join(
        __dirname,
        "..",
        "templates",
        "email-verification-success.html",
      ),
    );
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.get("/reset-password", authLimiter, async (req, res) => {
  try {
    if (!req.query.token) throw new Error("Token is required");

    const result = verifyVerificationToken(req.query.token);
    if (!result.success) throw new Error(result.message);

    // Token type-confusion guard, and the most consequential of the three: this
    // handler renders the account's stored `resetPasswordToken` into the form
    // action below. Without the check, an "email" verification token — which
    // sits in the user's inbox from registration — could be replayed here to
    // READ the reset-password-action token and complete a full takeover, since
    // anyone may trigger a reset for a known address. Only the link token minted
    // by sendResetPasswordEmail may render this page.
    if (result.data.type !== "reset-password-link")
      throw new Error("Your token is invalid!");

    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: result.data.projectCode },
      select: { code: 1, userId: 1, name: 1 },
    });

    if (!project)
      throw new Error(
        "The project you're registered in is no longer available!",
      );

    const account = await getDocument({
      userId: project.userId,
      projectCode: project.code,
      collectionName: authCollectionName,
      query: { _id: result.data.accountId },
      select: { resetPasswordToken: 1 },
    });

    if (!account)
      throw new Error(
        "The Account you're registered with is no longer available!",
      );

    if (!account.resetPasswordToken)
      throw new Error("The token you're providing was already used!");

    const actionTokenVerifyResult = verifyVerificationToken(
      account.resetPasswordToken,
    );
    if (!actionTokenVerifyResult.success)
      throw new Error(actionTokenVerifyResult.message);

    const templatePath = path.join(
      __dirname,
      "..",
      "templates",
      "reset-password-page.html",
    );
    let html = await fs.promises.readFile(templatePath, "utf8");
    const variables = {
      projectName: project.name,
      formAction: `/reset-password?token=${account.resetPasswordToken}`,
    };
    Object.keys(variables).forEach((key) => {
      html = html.replace(new RegExp(`{{${key}}}`, "g"), variables[key]);
    });

    res.send(html);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post("/reset-password", authLimiter, async (req, res) => {
  try {
    if (!req.query.token)
      throw new Error("Form action is not in a valid form!");
    if (!req.body.newPassword) throw new Error("New password is required!");
    const actionTokenVerifyResult = verifyVerificationToken(req.query.token);
    if (!actionTokenVerifyResult.success)
      throw new Error(actionTokenVerifyResult.message);

    // Token type-confusion guard: ONLY a token minted specifically for the
    // reset *action* may set a new password. Without this, an email-verification
    // token (same JWT shape & secret) could be replayed here to take over an
    // account. See verification_service.generateVerificationToken types.
    if (actionTokenVerifyResult.data.type !== "reset-password-action")
      throw new Error("Your token is invalid!");

    if (!isStrongPassword(req.body.newPassword))
      throw new Error(
        "Password is very weak, try harder one with at least, one capital letter, small letters and a symbol",
      );

    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: actionTokenVerifyResult.data.projectCode },
      select: { code: 1, userId: 1 },
    });

    if (!project)
      throw new Error(
        "The project you're registered in is no longer available!",
      );

    // Single-use enforcement: the presented token must equal the token CURRENTLY
    // stored on the account (constant-time compare). It is nulled below on
    // success, so a captured-but-already-used token can't be replayed within its
    // 10-minute validity window.
    const account = await getDocument({
      userId: project.userId,
      projectCode: project.code,
      collectionName: authCollectionName,
      query: { _id: actionTokenVerifyResult.data.accountId },
      select: { resetPasswordToken: 1 },
    });
    if (!account || !account.resetPasswordToken)
      throw new Error("The token you're providing was already used!");
    const storedBuf = Buffer.from(String(account.resetPasswordToken));
    const presentedBuf = Buffer.from(String(req.query.token));
    if (
      storedBuf.length !== presentedBuf.length ||
      !crypto.timingSafeEqual(storedBuf, presentedBuf)
    )
      throw new Error("Your token is invalid!");

    const updateResult = await updateDocument({
      userId: project.userId,
      projectCode: project.code,
      collectionName: authCollectionName,
      query: { _id: actionTokenVerifyResult.data.accountId },
      updateData: {
        password: await hashPassword(req.body.newPassword),
        resetPasswordToken: null,
      },
    });

    if (updateResult.modifiedCount < 1)
      throw new Error(
        "An unknown problem happend while setting your new password!",
      );

    res
      .status(200)
      .json({ message: "Your new password has been set successfully!" });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
