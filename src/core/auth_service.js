const { authCollectionName } = require("../constants");

const {
  hashPassword,
  verifyPassword,
  getToken,
  verifyToken,
} = require("../utils/encryptions");
const Logger = require("../utils/logger");

const { getUserDB } = require("./client");
const { getDocument, updateDocument } = require("./db_service");
const {
  sendVerifyAccountEmail,
  sendRecoverPasswordEmail,
} = require("./email_service");
const { generateVerificationToken } = require("./verification_service");

// register with email
async function registerWithEmailAndPassword({
  userId,
  projectCode,
  name,
  email,
  password,
  avatar,
  roles = [],
  expiresIn,
}) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(authCollectionName);
  // check email
  const exists = await collection.findOne({ email });
  if (exists) throw new Error("This email is already registered!");

  const user = {
    name: name || "",
    avatar: avatar || "",
    email,
    isActive: true,
    roles,
    emailVerified: false,
    password: await hashPassword(password),
    lastLoginAt: new Date(),
  };

  // Ensure indexes for fast lookups
  await collection.createIndex({ createdAt: 1 });
  await collection.createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $exists: true } } },
  );

  await collection.insertOne({ ...user, createdAt: new Date() });
  // Registration mints its token by delegating to login, so the project's
  // lifetime has to be forwarded here or a newly registered user would get the
  // 30-day default while every subsequent login got the configured one.
  return await loginWithEmailAndPassword({
    userId,
    projectCode,
    email,
    password,
    expiresIn,
  });
}

async function loginWithEmailAndPassword({
  userId,
  projectCode,
  email,
  password,
  expiresIn,
}) {
  const user = await getDocument({
    userId,
    projectCode,
    collectionName: authCollectionName,
    query: { email },
  });
  if (!user) throw Error("Invalid email or password");
  if (!user.isActive) throw Error("Your account is disabled");

  // Account lockout: reject if still within the lockout window. A lockedUntil
  // value that isn't a parseable date (corrupted data, however it got there)
  // is treated as locked rather than silently ignored — `new Date(garbage) >
  // new Date()` is always false, which used to make lockout a no-op for that
  // account until a valid future date was written again.
  if (user.lockedUntil) {
    const lockedUntilMs = new Date(user.lockedUntil).getTime();
    if (Number.isNaN(lockedUntilMs) || lockedUntilMs > Date.now()) {
      throw Error("Account is temporarily locked due to too many failed attempts. Try again later.");
    }
  }

  const { match, needsRehash } = await verifyPassword(password, user.password);
  if (!match) {
    // Increment failed attempts and lock after 10 consecutive failures for 15 minutes.
    const MAX_ATTEMPTS = 10;
    const LOCKOUT_MS = 15 * 60 * 1000;
    // Number(...) rather than `|| 0`: a corrupted non-numeric value would
    // otherwise stay truthy, add 1 to it, produce NaN, and never reach
    // MAX_ATTEMPTS — silently disabling lockout for that account.
    const priorAttempts = Number(user.failedLoginAttempts);
    const failedLoginAttempts = (Number.isFinite(priorAttempts) ? priorAttempts : 0) + 1;
    const lockUpdate = { failedLoginAttempts };
    if (failedLoginAttempts >= MAX_ATTEMPTS) {
      lockUpdate.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
    }
    updateDocument({
      userId,
      projectCode,
      collectionName: authCollectionName,
      query: { _id: user._id },
      updateData: lockUpdate,
    }).catch((err) => Logger.error("Failed to update lockout state", { stack: err.stack }));
    throw Error("Invalid email or password");
  }

  // Reset lockout state on successful login.
  if (user.failedLoginAttempts || user.lockedUntil) {
    updateDocument({
      userId,
      projectCode,
      collectionName: authCollectionName,
      query: { _id: user._id },
      updateData: { failedLoginAttempts: 0, lockedUntil: null },
    }).catch((err) => Logger.error("Failed to reset lockout state", { stack: err.stack }));
  }

  // auto-migrate legacy AES password to bcrypt on successful login
  if (needsRehash) {
    const newHash = await hashPassword(password);
    updateDocument({
      userId,
      projectCode,
      collectionName: authCollectionName,
      query: { _id: user._id },
      updateData: { password: newHash },
    }).catch((err) => Logger.error("Failed to rehash legacy password", { stack: err.stack }));
  }

  // tokenVersion is embedded so a later /revoke-tokens call (which bumps the
  // stored value) instantly invalidates every token minted before it — see
  // the version check in user_auth.middleware.js / socket_auth.middleware.js.
  // Default to 0 for accounts created before this field existed.
  user.token = getToken(
    {
      userId: user._id,
      project: projectCode,
      tokenVersion: user.tokenVersion || 0,
    },
    // undefined falls through to getToken's own default (tokenExpiry.auth),
    // so a project that never set a lifetime is byte-identical to before.
    { expiresIn },
  );
  user.uid = user._id.toString();
  delete user._id;
  delete user.password;
  delete user.createdAt;
  delete user.isActive;
  delete user.lastLoginAt;
  delete user.resetPasswordToken;
  delete user.failedLoginAttempts;
  delete user.lockedUntil;
  return user;
}

async function loginWithToken(userId, projectCode, token) {
  const decoded = verifyToken(token);
  // Reject tokens that aren't bound to THIS project (or are invalid/expired) so
  // a token from another project can't be exchanged for a session here.
  if (!decoded || decoded.expired || decoded.project !== projectCode)
    throw Error("Invalid or expired token");
  const user = await getDocument({
    userId,
    projectCode,
    collectionName: authCollectionName,
    query: { _id: decoded.userId },
  });
  if (!user) throw Error("User not found!");
  // Revocation check: same tokenVersion comparison used by checkDbUserApiAuth,
  // socketAuth and set-user-token. This route was missing it, so a revoked
  // token could still exchange for a session here.
  const tokenVersion = decoded.tokenVersion || 0;
  if ((user.tokenVersion || 0) !== tokenVersion) throw Error("Invalid or expired token");
  user.token = token;
  user.uid = user._id.toString();
  delete user._id;
  delete user.password;
  delete user.createdAt;
  delete user.isActive;
  delete user.lastLoginAt;
  delete user.resetPasswordToken;
  return user;
}

async function anonymousLogin(userId, projectCode, { name, avatar }, { expiresIn } = {}) {
  const db = await getUserDB(userId, projectCode);
  const collection = db.collection(authCollectionName);

  const user = {
    name: name || "",
    avatar: avatar || "",
    isActive: true,
    lastLoginAt: new Date(),
  };

  // Ensure indexes for fast lookups
  await collection.createIndex({ createdAt: 1 });
  const result = await collection.insertOne({
    ...user,
    createdAt: new Date(),
  });

  // Freshly created — no tokenVersion field yet, so it defaults to 0 (see the
  // comment in loginWithEmailAndPassword above).
  user.token = getToken(
    {
      userId: result.insertedId,
      project: projectCode,
      tokenVersion: user.tokenVersion || 0,
    },
    { expiresIn },
  );
  user.uid = result.insertedId.toString();
  return user;
}

async function changePassword({
  userId,
  projectCode,
  accountId,
  oldPassword,
  newPassword,
}) {
  const user = await getDocument({
    userId,
    projectCode,
    collectionName: authCollectionName,
    query: { _id: accountId },
    select: { password: 1 },
  });
  if (!user) throw new Error("Accounts doesn't exist!");

  const { match } = await verifyPassword(oldPassword, user.password);
  if (!match) throw new Error("Old password is incorrect!");

  const result = await updateDocument({
    userId,
    projectCode,
    collectionName: authCollectionName,
    query: { _id: accountId },
    updateData: { password: await hashPassword(newPassword) },
  });

  return result;
}

//
async function sendVerifyEmail({ project, email, baseUrl }) {
  const account = await getDocument({
    userId: project.userId,
    projectCode: project.code,
    collectionName: authCollectionName,
    query: { email },
  });
  if (!account) throw new Error("Your Account wasn't found!");
  if (account.emailVerified === true)
    throw new Error("Email is already verified!");

  const token = generateVerificationToken({
    project,
    account,
    type: "email",
  });
  if (!token) throw new Error("Couldn't generate a token for your account!");

  const link = baseUrl + token;
  await sendVerifyAccountEmail({ project, email, link });

  return true;
}

//
async function sendResetPasswordEmail({ project, email, baseUrl }) {
  try {
    const account = await getDocument({
      userId: project.userId,
      projectCode: project.code,
      collectionName: authCollectionName,
      query: { email },
    });
    if (!account) throw new Error("Your Account wasn't found!");

    // Invalidate any existing reset token before generating a new one
    // so only one active reset link exists at a time.
    await updateDocument({
      userId: project.userId,
      projectCode: project.code,
      collectionName: authCollectionName,
      query: { email },
      updateData: { resetPasswordToken: null },
    });

    const linkToken = generateVerificationToken({
      project,
      account,
      type: "reset-password-link",
    });
    if (!linkToken)
      throw new Error(
        "Couldn't generate a token for your account password reset!",
      );

    const link = baseUrl + linkToken;
    await sendRecoverPasswordEmail({ project, email, link });

    const actionToken = generateVerificationToken({
      project,
      account,
      type: "reset-password-action",
    });
    if (!actionToken)
      throw new Error(
        "Couldn't generate a token for your account password reset!",
      );

    await updateDocument({
      userId: project.userId,
      projectCode: project.code,
      collectionName: authCollectionName,
      query: { email },
      updateData: { resetPasswordToken: actionToken },
    });

    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  registerWithEmailAndPassword,
  loginWithEmailAndPassword,
  loginWithToken,
  anonymousLogin,
  changePassword,
  sendVerifyEmail,
  sendResetPasswordEmail,
};
