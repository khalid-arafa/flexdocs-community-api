const express = require("express");
const router = express.Router();
const Logger = require("../utils/logger");

const { systemApiAuth, adminAuth } = require("../middleware/system_auth.middleware");
const { zodValidate } = require("../middleware/zod_validate.middleware");
const { emailSettingsSchema } = require("../utils/schemas");
const {
  getMaskedEmailConfig,
  saveEmailConfig,
} = require("../core/config_service");
const { sendEmail } = require("../core/email_service");

// All settings routes require an authenticated system admin.
router.use(systemApiAuth, adminAuth);

// Current email config (secrets masked).
router.get("/email", async (_req, res) => {
  try {
    return res.status(200).json(await getMaskedEmailConfig());
  } catch (error) {
    Logger.error("GET /settings/email failed: " + error.message, { stack: error.stack });
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Update email config. Secret fields are only changed when a new (non-masked)
// value is provided. Returns the masked config.
router.put("/email", zodValidate(emailSettingsSchema), async (req, res) => {
  try {
    const masked = await saveEmailConfig(req.body);
    return res.status(200).json(masked);
  } catch (error) {
    // saveEmailConfig throws clear provider-requirement messages → 400.
    return res.status(400).json({ message: error.message });
  }
});

// Send a test email using the current resolved config.
router.post("/email/test", async (req, res) => {
  const to = (req.body && req.body.to) || req.sender?.email;
  if (!to) return res.status(400).json({ message: "No recipient address available" });
  try {
    const result = await sendEmail({
      email: to,
      title: "Test email",
      body: "This is a test email from your FlexDocs instance. If you received it, email is configured correctly.",
    });
    if (!result.success)
      return res.status(400).json({ message: result.error || "Failed to send test email" });
    return res.status(200).json({ success: true, provider: result.provider });
  } catch (error) {
    Logger.error("POST /settings/email/test failed: " + error.message, { stack: error.stack });
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
