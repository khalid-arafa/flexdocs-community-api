const crypto = require("crypto");
const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
} = require("../constants");
const { getDocument } = require("../core/db_service");
const { hashProjectToken } = require("../utils/helper");

async function projectApiAuth(req, res, next) {
  if (!req.params.projectCode)
    return res.status(404).json({ message: "Project code not provided!" });
  const select = {
    name: 1,
    code: 1,
    isPublic: 1,
    isActive: 1,
    userId: 1,
    dbRules: 1,
    authRules: 1,
    credentials: 1,
  };

  if (req.params.projectCode === "_system" && req.byAdmin) {
    req.project = {
      userId: systemDatabaseName,
      code: systemProjectCode,
      name: "System",
      isActive: true,
      isPublic: true,
    };
    next();
    return;
  }

  const project = await getDocument({
    userId: systemDatabaseName,
    projectCode: systemProjectCode,
    collectionName: systemProjectCollectionName,
    query: { code: req.params.projectCode },
    select,
  });

  if (!project) {
    return res.status(404).json({ message: "Project was not found!" });
  }

  if (!req.byAdmin && !project.isActive) {
    return res.status(404).json({ message: "Project was not found!" });
  }

  if (!req.byAdmin && !project.isPublic) {
    const publicRoutes = [
      "/login-with-email",
      "/register-with-email",
      "/login-with-token",
      "/anonymous-login",
      "/register-with-phone",
      "/send-email-verification",
      "/send-reset-password-email",
    ];

    if (!publicRoutes.includes(req.path)) {
      const projectToken = req.headers["project-token"];
      if (!projectToken)
        return res.status(404).json({ message: "This project is private!" });
      const incomingHash = hashProjectToken(projectToken);
      const incomingBuf = Buffer.from(incomingHash, "hex");
      const validToken = project.credentials.find((i) => {
        const storedHash = i.creds.projectTokenHash;
        if (!storedHash) return false;
        const storedBuf = Buffer.from(storedHash, "hex");
        return storedBuf.length === incomingBuf.length &&
          crypto.timingSafeEqual(storedBuf, incomingBuf);
      });
      if (!validToken)
        return res.status(404).json({ message: "This project is private!" });
    }
  }
  req.project = project;
  next();
}

// implement storage rules

module.exports = {
  projectApiAuth,
};
