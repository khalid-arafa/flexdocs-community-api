const { Resend } = require("resend");
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");
const Logger = require("../utils/logger");
const { getResolvedEmailConfig } = require("./config_service");

// Provider clients are built per-send from the resolved config so runtime
// changes (via the settings API) take effect without a restart.

// Escape HTML special characters to prevent injection in email templates
function escapeHtml(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Keys whose values are URLs used in href attributes — encode for URI safety
// but don't HTML-entity-escape (would break the URL in the href)
const URL_KEYS = new Set([
  "verificationLink",
  "resetLink",
]);

// Load and process HTML templates
const loadTemplate = async (templateName, variables = {}) => {
  try {
    const templatePath = path.join(
      __dirname,
      "..",
      "templates",
      `${templateName}.html`,
    );
    let template = await fs.readFile(templatePath, "utf8");

    Object.keys(variables).forEach((key) => {
      const placeholder = new RegExp(`{{${key}}}`, "g");
      const raw = variables[key] || "";
      // URLs in href are safe; everything else gets HTML-escaped
      const safe = URL_KEYS.has(key) ? raw : escapeHtml(raw);
      template = template.replace(placeholder, safe);
    });

    return template;
  } catch (error) {
    Logger.error(`[Email] Failed to load template ${templateName}: ${error.message}`);
    return null;
  }
};

// Send email via Resend
const sendViaResend = async (cfg, { email, title, htmlContent, textContent }) => {
  const resendClient = new Resend(cfg.resendApiKey);

  const emailData = {
    from: cfg.from?.email || "onboarding@resend.dev",
    to: email,
    subject: title,
    text: textContent,
    html: htmlContent,
  };

  // Resend SDK (v6) returns { data, error } and does NOT throw on API errors,
  // so we must inspect `error` ourselves — otherwise a bad key/sender would be
  // reported as a successful send. Throwing here lets sendEmail's catch turn it
  // into { success: false, error }.
  const { data, error } = await resendClient.emails.send(emailData);
  if (error) {
    throw new Error(error.message || error.name || "Resend rejected the request");
  }
  return { success: true, messageId: data?.id, provider: "resend" };
};

// Send email via Nodemailer (SMTP)
const sendViaNodemailer = async (cfg, { email, title, htmlContent, textContent }) => {
  const mail = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port || 587,
    secure: (cfg.smtp.port || 587) === 465,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });

  const emailData = {
    from: `${cfg.from?.name || "App"} <${cfg.from?.email || cfg.smtp.user}>`,
    to: email,
    subject: title,
    text: textContent,
    html: htmlContent,
  };

  const result = await mail.sendMail(emailData);
  return { success: true, messageId: result.messageId, provider: "smtp" };
};

// Base email sending function
const sendEmail = async ({
  email,
  title,
  body,
  isHtml = false,
  templateName = null,
  templateVars = {},
}) => {
  // Input validation
  if (!email || !title) {
    const error = new Error("Email and title are required");
    Logger.error("[Email] " + error.message);
    return { success: false, error: error.message };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    const error = new Error("Invalid email format");
    Logger.error("[Email] " + error.message);
    return { success: false, error: error.message };
  }

  const cfg = await getResolvedEmailConfig();
  if (!cfg.provider) {
    const error = new Error(
      "No email provider configured. Configure email in settings, or set RESEND_API_KEY / SMTP credentials.",
    );
    Logger.error("[Email] " + error.message);
    return { success: false, error: error.message };
  }

  try {
    let htmlContent = body;
    let textContent = body;

    // Load HTML template if specified
    if (templateName) {
      const template = await loadTemplate(templateName, templateVars);
      if (template) {
        htmlContent = template;
        isHtml = true;
        textContent = template
          .replace(/<[^>]*>/g, "")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        Logger.warn(`[Email] Template ${templateName} not found, using plain body`);
      }
    }

    // Ensure HTML content if isHtml is true
    if (isHtml && !htmlContent.includes("<")) {
      htmlContent = `<p>${htmlContent}</p>`;
    }

    // Send via appropriate provider
    let result;
    if (cfg.provider === "resend") {
      result = await sendViaResend(cfg, { email, title, htmlContent, textContent });
    } else {
      result = await sendViaNodemailer(cfg, { email, title, htmlContent, textContent });
    }

    Logger.info(`[Email] Sent via ${result.provider} to ${email} - ID: ${result.messageId}`);
    return result;
  } catch (error) {
    Logger.error(`[Email] Failed to send to ${email}: ${error.message}`);
    return {
      success: false,
      error: `Email delivery failed: ${error.message}`,
      provider: cfg.provider,
    };
  }
};

// Send password recovery email
const sendRecoverPasswordEmail = async ({ project, email, link }) => {
  if (!email || !link) {
    const error = new Error("Email and recovery link are required");
    Logger.error("[Email] " + error.message);
    return { success: false, error: error.message };
  }

  try {
    new URL(link);
  } catch (error) {
    Logger.error("[Email] Invalid recovery link format");
    return { success: false, error: "Invalid recovery link format" };
  }

  const templateVars = {
    email: email,
    resetLink: link,
    appName: project?.name || process.env.APP_NAME || "App",
    supportEmail: process.env.SUPPORT_EMAIL || "",
    expirationTime: "10 minutes",
  };

  const result = await sendEmail({
    email,
    title: "Password Reset Request",
    body: `Reset your password by clicking this link: ${link}`,
    templateName: "reset-password.template",
    templateVars,
  });

  if (!result.success) {
    Logger.error("[Email] Password recovery email failed: " + result.error);
  }

  return result;
};

// Send account verification email
const sendVerifyAccountEmail = async ({ project, email, link }) => {
  if (!email || !link) {
    const error = new Error("Email and verification link are required");
    Logger.error("[Email] " + error.message);
    return { success: false, error: error.message };
  }

  try {
    new URL(link);
  } catch (error) {
    Logger.error("[Email] Invalid verification link format");
    return { success: false, error: "Invalid verification link format" };
  }

  const templateVars = {
    email: email,
    verificationLink: link,
    appName: project?.name || process.env.APP_NAME || "App",
    supportEmail: process.env.SUPPORT_EMAIL || "",
  };

  const result = await sendEmail({
    email,
    title: "Verify Your Account",
    body: `Verify your account by clicking this link: ${link}`,
    templateName: "email-verification.template",
    templateVars,
  });

  if (!result.success) {
    Logger.error("[Email] Account verification email failed: " + result.error);
  }

  return result;
};

module.exports = {
  sendEmail,
  sendRecoverPasswordEmail,
  sendVerifyAccountEmail,
};
