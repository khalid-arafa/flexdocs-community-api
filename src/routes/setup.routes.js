const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Logger = require("../utils/logger");

const { registerWithEmailAndPassword } = require("../core/auth_service");
const { countDocuments } = require("../core/db_service");
const {
  systemDatabaseName,
  systemProjectCode,
  authCollectionName,
} = require("../constants");
const { authLimiter } = require("../middleware/rate_limit.middleware");
const { zodValidate } = require("../middleware/zod_validate.middleware");
const { setupSchema } = require("../utils/schemas");

const SETUP_TEMPLATE = path.join(__dirname, "..", "templates", "setup-page.html");

// Setup is "needed" until a system admin exists. Element match (roles: "admin")
// is robust to roles like ["admin","superadmin"].
async function needsSetup() {
  const count = await countDocuments({
    userId: systemDatabaseName,
    projectCode: systemProjectCode,
    collectionName: authCollectionName,
    query: { roles: "admin" },
  });
  return count === 0;
}

// Constant-time comparison of the provided setup token against SETUP_TOKEN.
// Returns { configured } so we can distinguish "no token set on server" from
// "wrong token".
function checkToken(provided) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected || expected.trim() === "") return { configured: false, ok: false };
  if (!provided) return { configured: true, ok: false };
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return { configured: true, ok: false };
  return { configured: true, ok: crypto.timingSafeEqual(a, b) };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dashboardUrl() {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;
  const origins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origins[0] || "http://admin.localhost";
}

// JSON status — useful for clients/dashboards to detect a fresh install.
router.get("/setup/status", async (_req, res) => {
  try {
    return res.status(200).json({ needsSetup: await needsSetup() });
  } catch (error) {
    Logger.error("setup/status failed: " + error.message, { stack: error.stack });
    return res.status(500).json({ message: "Internal server error" });
  }
});

// First-run wizard page.
router.get("/setup", async (req, res) => {
  try {
    if (!(await needsSetup())) {
      return res
        .status(200)
        .send(
          `<!doctype html><meta charset="utf-8"><title>Already configured</title>` +
            `<div style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">` +
            `<h1>Already configured</h1><p>This instance already has an administrator.</p>` +
            `<p><a href="${escapeHtml(dashboardUrl())}">Go to dashboard</a></p></div>`,
        );
    }

    // Token from the install link; strip to a safe charset before injecting into
    // the page's inline script to avoid breaking out of the JS string.
    const rawToken = typeof req.query.token === "string" ? req.query.token : "";
    const safeToken = rawToken.replace(/[^A-Za-z0-9+/=_-]/g, "");

    let html = fs.readFileSync(SETUP_TEMPLATE, "utf8");
    const vars = {
      appName: escapeHtml(process.env.APP_NAME || "FlexDocs"),
      token: safeToken,
      formAction: "/setup",
      dashboardUrl: escapeHtml(dashboardUrl()),
    };
    for (const key of Object.keys(vars)) {
      html = html.replace(new RegExp(`{{${key}}}`, "g"), vars[key]);
    }
    return res.status(200).send(html);
  } catch (error) {
    Logger.error("GET /setup failed: " + error.message, { stack: error.stack });
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Create the single admin account (token-gated, one-time).
router.post("/setup", authLimiter, zodValidate(setupSchema), async (req, res) => {
  try {
    if (!(await needsSetup()))
      return res.status(403).json({ message: "Setup has already been completed." });

    const { configured, ok } = checkToken(req.body.token || req.query.token);
    if (!configured)
      return res
        .status(403)
        .json({ message: "Setup token is not configured on the server." });
    if (!ok) return res.status(403).json({ message: "Invalid setup token." });

    const { name, email, password } = req.body;
    await registerWithEmailAndPassword({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      name,
      email,
      password,
      roles: ["admin"],
    });
    Logger.info("Admin account created via setup wizard", { email });
    return res
      .status(200)
      .json({ success: true, message: "Administrator account created." });
  } catch (error) {
    Logger.error("POST /setup failed: " + error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});

module.exports = router;
