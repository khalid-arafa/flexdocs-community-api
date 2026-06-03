const { authCollectionName, authCookieNames } = require("../constants");
const { getDocument } = require("../core/db_service");
const { verifyToken } = require("../utils/encryptions");

async function checkDbUserApiAuth(req, res, next) {
  const cookieToken = req.cookies && req.cookies[authCookieNames.legacy];
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
  const token = cookieToken || bearerToken;

  if (!token) {
    next();
    return;
  }

  try {
    const decodedToken = verifyToken(token);
    if (decodedToken && !decodedToken.expired) {
      // Load the full account (minus secrets) so DB rules can reference
      // user fields such as roles, email, emailVerified, etc. Selecting only
      // _id/username previously made role-based rules silently fail over HTTP.
      const user = await getDocument({
        userId: req.project.userId,
        projectCode: req.project.code,
        collectionName: authCollectionName,
        query: { _id: decodedToken.userId },
        select: {
          password: 0,
          resetPasswordToken: 0,
          failedLoginAttempts: 0,
          lockedUntil: 0,
        },
      });
      if (user) {
        req.sender = user;
      }
    }
  } catch (error) {
    // token decode failed — continue unauthenticated
  }
  next();
}

module.exports = {
  checkDbUserApiAuth,
};
