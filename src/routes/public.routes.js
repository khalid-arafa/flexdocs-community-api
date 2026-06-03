const express = require("express");
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
const router = express.Router();

router.get("/verify", async (req, res) => {
  try {
    if (!req.query.token) throw new Error("Token is required");

    const result = verifyVerificationToken(req.query.token);
    if (!result.success) throw new Error(result.message);

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

router.get("/reset-password", async (req, res) => {
  try {
    if (!req.query.token) throw new Error("Token is required");

    const result = verifyVerificationToken(req.query.token);
    if (!result.success) throw new Error(result.message);

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
    if (!actionTokenVerifyResult.success) throw new Error(result.message);

    const templatePath = path.join(
      __dirname,
      "..",
      "templates",
      "reset-password-page.html",
    );
    let html = fs.readFileSync(templatePath, "utf8");
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

router.post("/reset-password", async (req, res) => {
  try {
    if (!req.query.token)
      throw new Error("Form action is not in a valid form!");
    if (!req.body.newPassword) throw new Error("New password is required!");
    const actionTokenVerifyResult = verifyVerificationToken(req.query.token);
    if (!actionTokenVerifyResult.success) throw new Error(result.message);
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
