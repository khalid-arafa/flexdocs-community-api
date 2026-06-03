const {
  systemDatabaseName,
  systemProjectCode,
  authCollectionName,
  authCookieNames,
} = require("../constants");
const { getDocument } = require("../core/db_service");
const { verifyToken } = require("../utils/encryptions");

async function systemApiAuth(req, res, next) {
  let token;
  const cookieToken = req.cookies && req.cookies[authCookieNames.system];
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
  token = cookieToken || bearerToken;

  if (!token) {
    return res.status(403).json({
      message: "Access denied. No token provided.",
    });
  }

  try {
    const decodedToken = verifyToken(token);
    if (!decodedToken) {
      return res.status(401).json({
        message: "Access denied. Invalid token.",
      });
    }
    if (decodedToken.expired) {
      return res.status(401).json({
        message: "Session expired. Please log in again.",
        expired: true,
      });
    }
    // user
    const user = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: decodedToken.userId },
    });
    if (!user)
      return res.status(404).json({
        message: "Access denied. Token user was not found.",
      });

    req.sender = user;
    req.isDbAdmin = true;
    req.byAdmin =
      user.roles &&
      ["admin", "superadmin"].some((role) => user.roles.includes(role));
    req.bySuperAdmin =
      user.roles && ["superadmin"].some((role) => user.roles.includes(role));
    next();
  } catch (error) {
    req.sender = false;
    return res.status(401).json({
      message: "Access denied. Invalid token.",
    });
  }
}

// check
async function checkSystemApiAuth(req, res, next) {
  let token;
  const cookieToken = req.cookies && req.cookies[authCookieNames.dbUser];
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;
  const queryToken = req.query.token;
  token = cookieToken || bearerToken || queryToken;

  if (!token) {
    next();
    return;
  }

  try {
    const decodedToken = verifyToken(token);

    if (!decodedToken) {
      next();
      return;
    }

    if (decodedToken.expired) {
      return res.status(401).json({
        message: "Session expired. Please log in again.",
        expired: true,
      });
    }

    // user
    const user = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: authCollectionName,
      query: { _id: decodedToken.userId },
      select: { password: 0, lastLoginAt: 0, createdAt: 0 },
    });

    if (!user) {
      next();
      return;
    }

    if (!user.isActive)
      return res.status(403).json({
        message: "Your account is deactivated!",
      });

    req.sender = user;
    req.isDbAdmin = true;
    req.byAdmin =
      user.roles &&
      ["admin", "superadmin"].some((role) => user.roles.includes(role));
    req.bySuperAdmin =
      user.roles && ["superadmin"].some((role) => user.roles.includes(role));
    next();
  } catch (error) {
    req.sender = false;
    return res.status(401).json({
      message: "Access denied. Invalid token.",
    });
  }
}

async function adminAuth(req, res, next) {
  if (!req.byAdmin)
    return res.status(403).json({
      message: "Access denied. You are not authorized to perform this action.",
    });
  next();
}

async function superAdminAuth(req, res, next) {
  if (!req.bySuperAdmin)
    return res.status(403).json({
      message: "Access denied. You are not authorized to perform this action.",
    });
  next();
}

module.exports = {
  systemApiAuth,
  adminAuth,
  superAdminAuth,
  checkSystemApiAuth,
};
