const { Resend } = require("resend");
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");
const Logger = require("../utils/logger");

let resend;
let transporter;
let emailProvider = null; // 'resend', 'nodemailer', or null

// Determine which email provider to use
const determineProvider = () => {
  if (emailProvider) return emailProvider;

  if (process.env.RESEND_API_KEY) {
    emailProvider = "resend";
    Logger.info("[Email] Using Resend provider");
  } else if (
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  ) {
    emailProvider = "nodemailer";
    Logger.info("[Email] Using Nodemailer provider");
  } else {
    Logger.error("[Email] No email provider configured");
    emailProvider = null;
  }

  return emailProvider;
};

// Create Resend instance
const createResend = () => {
  if (resend) return resend;
  resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
};

// Create Nodemailer transporter
const createTransporter = () => {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
};

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
const sendViaResend = async ({ email, title, htmlContent, textContent }) => {
  const resendClient = createResend();

  const emailData = {
    from: process.env.FROM_EMAIL || "onboarding@resend.dev",
    to: email,
    subject: title,
    text: textContent,
    html: htmlContent,
  };

  const result = await resendClient.emails.send(emailData);
  return { success: true, messageId: result.id, provider: "resend" };
};

// Send email via Nodemailer
const sendViaNodemailer = async ({
  email,
  title,
  htmlContent,
  textContent,
}) => {
  const mail = createTransporter();

  const emailData = {
    from: `${process.env.FROM_NAME || "App"} <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
    to: email,
    subject: title,
    text: textContent,
    html: htmlContent,
  };

  const result = await mail.sendMail(emailData);
  return { success: true, messageId: result.messageId, provider: "nodemailer" };
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

  const provider = determineProvider();
  if (!provider) {
    const error = new Error(
      "No email provider configured. Set RESEND_API_KEY or SMTP credentials",
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
    if (provider === "resend") {
      result = await sendViaResend({ email, title, htmlContent, textContent });
    } else {
      result = await sendViaNodemailer({
        email,
        title,
        htmlContent,
        textContent,
      });
    }

    Logger.info(`[Email] Sent via ${result.provider} to ${email} - ID: ${result.messageId}`);
    return result;
  } catch (error) {
    Logger.error(`[Email] Failed to send to ${email}: ${error.message}`);
    return {
      success: false,
      error: `Email delivery failed: ${error.message}`,
      provider,
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
