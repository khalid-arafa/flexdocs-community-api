const crypto = require("crypto");
const { getToken } = require("./encryptions");

function hashProjectToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Hosts we are willing to embed in user-facing links, derived from configured
// origins plus the local dev hosts. Used to reject Host-header poisoning.
function getAllowedLinkHosts() {
  const hosts = new Set(["api.localhost", "admin.localhost", "localhost", "127.0.0.1"]);
  const add = (u) => {
    if (!u) return;
    try {
      hosts.add(new URL(u).host);
    } catch {
      hosts.add(String(u).replace(/^https?:\/\//, "").split("/")[0]);
    }
  };
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach(add);
  add(process.env.DASHBOARD_URL);
  add(process.env.PUBLIC_API_URL);
  return hosts;
}

// Returns a TRUSTED absolute base URL (no trailing slash) for building
// user-facing links (password-reset / email-verification). Prevents
// Host-header poisoning: links are built from PUBLIC_API_URL when configured;
// otherwise the request Host is used ONLY if it is explicitly allowlisted, and
// a forged/unknown Host falls back to a safe configured origin.
function getPublicBaseUrl(req) {
  const configured = process.env.PUBLIC_API_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const host = req && typeof req.get === "function" ? req.get("host") : null;
  if (host && getAllowedLinkHosts().has(host)) {
    const proto = (req.protocol || "http").replace(/[^a-z]/gi, "");
    return `${proto}://${host}`;
  }

  const firstOrigin = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return (firstOrigin || "http://api.localhost").replace(/\/+$/, "");
}

function generateProjectCreds(req) {
  const payload = {
    projectId: req.params.id,
    name: req.project.name,
    code: req.project.code,
  };
  const projectToken = getToken(payload);
  return {
    ...payload,
    projectToken,
    projectTokenHash: hashProjectToken(projectToken),
    url: req.protocol + "://" + req.get("host"),
  };
}

module.exports = {
  generateProjectCreds,
  hashProjectToken,
  getPublicBaseUrl,
  getAllowedLinkHosts,
};
