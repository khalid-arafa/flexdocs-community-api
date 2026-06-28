const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
  authCollectionName,
} = require("../constants");
const { getDocument } = require("../core/db_service");
const { verifyToken } = require("../utils/encryptions");
const Logger = require("../utils/logger");

async function socketAuth(socket, next) {
  const projectToken =
    socket.handshake.auth?.projectToken ||
    socket.handshake.query?.projectToken;
  if (!projectToken)
    return next(new Error("Authentication error: Token required"));

  const userToken =
    socket.handshake.auth?.userToken || socket.handshake.query?.userToken;

  try {
    const decodedProjectToken = verifyToken(projectToken);
    // A real project token is signed as { projectId, name, code }. Require a
    // non-empty string `code`: without this, any other valid JWT (e.g. a user
    // token, which has no `code`) passes verify, and the lookup below would run
    // with code=undefined → formatQueryObj collapses it to {} → findOne({})
    // returns an ARBITRARY project, binding the socket to a project the caller
    // holds no credential for.
    if (
      !decodedProjectToken ||
      decodedProjectToken.expired ||
      typeof decodedProjectToken.code !== "string" ||
      decodedProjectToken.code.length === 0
    )
      return next(new Error("Authentication error: Invalid project token"));

    let project;
    if (decodedProjectToken.code === "_system") {
      project = {
        userId: "_system",
        code: "_system",
        name: "System",
        isPublic: true,
        isActive: true,
      };
    } else {
      project = await getDocument({
        userId: systemDatabaseName,
        projectCode: systemProjectCode,
        collectionName: systemProjectCollectionName,
        query: { code: decodedProjectToken.code },
      });
    }

    if (!project || !project.isActive)
      return next(new Error("Authentication error: Project not found"));

    socket.project = project;

    if (userToken) {
      const decodedUserToken = verifyToken(userToken);
      // Bind the user token to this project — a token minted for another project
      // must not authenticate a user against this one.
      if (
        decodedUserToken &&
        !decodedUserToken.expired &&
        decodedUserToken.project === project.code
      ) {
        // Look up user in the project's auth collection, not the system DB
        const sender = await getDocument({
          userId: project.userId,
          projectCode: project.code,
          collectionName: authCollectionName,
          query: { _id: decodedUserToken.userId },
        });
        socket.sender = sender;
      }
    }

    next();
  } catch (error) {
    Logger.error("Socket authentication failed", {
      error: error.message,
      file: __filename,
    });
    return next(new Error("Authentication error: " + error.message));
  }
}

module.exports = {
  socketAuth,
};
