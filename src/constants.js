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
  // Default-OFF: anonymous login silently mints a usable account/JWT, which —
  // combined with default-deny rules — should be an explicit opt-in, not the
  // default. Operators enable it per-project via the auth rules API.
  allowAnonymousLogin: false,
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
    // executables / scripts
    "exe", "bat", "cmd", "com", "msi", "scr", "pif", "vbs", "wsf", "wsh",
    // active web content — would execute as stored XSS if served inline
    "html", "htm", "xhtml", "shtml", "xml", "svg", "mhtml", "mht",
    "js", "mjs", "jsp", "asp", "aspx", "php", "phtml", "htaccess",
  ]),
  // Extensions safe to serve inline (e.g. image previews). Everything else is
  // forced to download via Content-Disposition: attachment.
  inlineExtensions: new Set([
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "pdf",
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
