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
    // Project binding: a user token is only valid for the project it was minted
    // for. Tokens are signed as { userId, project }. Without this check a token
    // from project A authenticates the same userId against project B's data.
    if (
      decodedToken &&
      !decodedToken.expired &&
      decodedToken.project === req.project.code
    ) {
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
      // Revocation check: /revoke-tokens bumps the user's stored tokenVersion,
      // which has no denylist or session store behind it — this comparison IS
      // the revocation mechanism. A token minted before this field existed
      // carries no `tokenVersion` claim at all, so it must be treated as
      // version 0; a user document from before this change is missing the
      // field too, same default. That keeps every currently-valid token
      // working unchanged until someone explicitly revokes for that user.
      const tokenVersion = decodedToken.tokenVersion || 0;
      if (user && (user.tokenVersion || 0) === tokenVersion) {
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
