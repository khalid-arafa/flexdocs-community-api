const reservedCollectionNames = [
  "admin",
  "_system",
  "_auth",
  "_config",
  "_projects",
  "_buckets",
  "_files",
  "_users",
];
const authCollectionName = "_users";
const systemDatabaseName = "_system";
const systemProjectCode = "_system";
const systemProjectCollectionName = "projects";

// auth rules
const defaultAuthRules = {
  allowEmailRegistration: true,
  allowAnonymousLogin: true,
  requireStrongPassword: false,
  allowPasswordReset: true,
  allowEmailVerification: true,
  requireEmailVerification: false,
};

// storage
const uploadsPath = "data/storage";
const bucketsCollectionName = "_buckets";
const filesCollectionName = "_files";

// upload limits
const uploadLimits = {
  maxFileSize: 50 * 1024 * 1024, // 50MB
  maxFileNameLength: 255,
  blockedExtensions: new Set([
    "exe", "bat", "cmd", "com", "msi", "scr", "pif", "vbs", "wsf", "wsh",
  ]),
};

// auth cookie names
const authCookieNames = {
  system: "flexdocs-auth-token",
  dbUser: "db-auth-token",
  legacy: "token",
};

// token expiry defaults
const tokenExpiry = {
  auth: "30d",
  verification: "10m",
};

// pagination defaults
const pagination = {
  defaultPage: 1,
  defaultLimit: 20,
  maxLimit: 500,
};

// image resize sizes
const imageSizes = {
  small: 300,
  medium: 800,
  large: 1200,
};

module.exports = {
  reservedCollectionNames,
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
  authCollectionName,
  //
  defaultAuthRules,
  //
  uploadsPath,
  bucketsCollectionName,
  filesCollectionName,
  //
  uploadLimits,
  authCookieNames,
  tokenExpiry,
  pagination,
  imageSizes,
};
