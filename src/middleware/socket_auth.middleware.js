const crypto = require("crypto");
const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
  authCollectionName,
} = require("../constants");
const { getDocument } = require("../core/db_service");
const { verifyToken, decodeExpiredToken } = require("../utils/encryptions");
const { hashProjectToken } = require("../utils/helper");
const Logger = require("../utils/logger");

// Is this exact token still a registered credential on the project?
//
// This is the same check projectApiAuth performs for REST: the stored
// `projectTokenHash` is the authority on whether a project token is live, and
// deleting the credential in the dashboard revokes it. Constant-time compare,
// and a credential minted before hashes were stored simply doesn't match.
function tokenMatchesStoredCredential(project, projectToken) {
  if (!Array.isArray(project?.credentials)) return false;
  const incomingBuf = Buffer.from(hashProjectToken(projectToken), "hex");
  return project.credentials.some((credential) => {
    const storedHash = credential?.creds?.projectTokenHash;
    if (!storedHash) return false;
    const storedBuf = Buffer.from(storedHash, "hex");
    return (
      storedBuf.length === incomingBuf.length &&
      crypto.timingSafeEqual(storedBuf, incomingBuf)
    );
  });
}

async function socketAuth(socket, next) {
  const projectToken =
    socket.handshake.auth?.projectToken ||
    socket.handshake.query?.projectToken;
  if (!projectToken)
    return next(new Error("Authentication error: Token required"));

  const userToken =
    socket.handshake.auth?.userToken || socket.handshake.query?.userToken;

  try {
    let decodedProjectToken = verifyToken(projectToken);

    // An expired project token is not automatically dead here.
    //
    // Project tokens are project-level credentials, not user sessions, and
    // their authority comes from the project document rather than the clock:
    // REST (projectApiAuth) authenticates one by SHA-256 hashing it and
    // comparing against the project's stored `projectTokenHash`, and never
    // decodes the JWT at all. `exp` has therefore never been enforced on that
    // path. Sockets were the only place it was, which meant a token silently
    // kept working for every REST call while realtime and file uploads broke
    // the moment it aged out — and nothing surfaces that to the client, since
    // socket.io just buffers the emit and an upload sits at 0% forever.
    //
    // So use the same authority REST does. The signature is still verified
    // (`decodeExpiredToken` only relaxes `exp`), and the credential check
    // below applies to every token regardless of age. Revocation is deleting
    // or rotating the credential in the dashboard; the `exp` claim these
    // tokens carry is vestigial for real projects.
    const expired = Boolean(decodedProjectToken?.expired);
    if (expired) {
      decodedProjectToken = decodeExpiredToken(projectToken);
    }

    // A real project token is signed as { projectId, name, code }. Require a
    // non-empty string `code`: without this, any other valid JWT (e.g. a user
    // token, which has no `code`) passes verify, and the lookup below would run
    // with code=undefined → formatQueryObj collapses it to {} → findOne({})
    // returns an ARBITRARY project, binding the socket to a project the caller
    // holds no credential for.
    if (
      !decodedProjectToken ||
      typeof decodedProjectToken.code !== "string" ||
      decodedProjectToken.code.length === 0
    )
      return next(new Error("Authentication error: Invalid project token"));

    // `_system` is synthesised below rather than read from Mongo, so it has no
    // stored credential hash to fall back on. `exp` is the only revocation
    // signal it has — keep enforcing it there.
    if (expired && decodedProjectToken.code === "_system")
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

    // Every project token must be a currently-registered credential — not just
    // the expired ones. Deliberately after the project lookup, since the stored
    // hashes live on the project document.
    //
    // This check used to run only when `expired` was true, which quietly made
    // the comment above it false: deleting a credential in the dashboard
    // revoked a token on REST immediately (projectApiAuth compares hashes on
    // every request) but did nothing on sockets until the token happened to
    // age out — up to 30 days later. Revocation that works on one transport
    // and not the other is worse than either, because the operator believes
    // the token is dead.
    //
    // Costs nothing extra: it is a hash and a compare against a document
    // already in hand. `_system` is exempt because it is synthesised above
    // rather than read from Mongo, so it has no credential list to match —
    // `exp` remains its only revocation signal, which is why the expiry check
    // for it stays in place further up.
    if (
      decodedProjectToken.code !== "_system" &&
      !tokenMatchesStoredCredential(project, projectToken)
    )
      return next(new Error("Authentication error: Invalid project token"));

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
        // Revocation check, mirroring user_auth.middleware.js: /revoke-tokens
        // bumps the stored tokenVersion, and a mismatch here means the token
        // was issued before that revocation. Absent claim/field both default
        // to 0 so pre-existing tokens keep authenticating unchanged.
        const tokenVersion = decodedUserToken.tokenVersion || 0;
        if (sender && (sender.tokenVersion || 0) === tokenVersion) {
          socket.sender = sender;
        }
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
