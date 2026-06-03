// Runtime-editable system configuration (currently: email/SMTP + Resend).
// Stored in the _system database's _config collection under { key: "email" }.
// Secrets (SMTP password, Resend API key) are encrypted at rest with
// ENCRYPTION_KEY and never returned by the masked getter. If no DB config is
// present, email settings fall back to the corresponding environment variables.

const { getUserDB } = require("./client");
const { encrypt, decrypt } = require("../utils/encryptions");
const { systemDatabaseName, systemProjectCode } = require("../constants");
const Logger = require("../utils/logger");

const CONFIG_COLLECTION = "_config";
const EMAIL_KEY = "email";
const MASK = "********";

async function configCollection() {
  const db = await getUserDB(systemDatabaseName, systemProjectCode);
  return db.collection(CONFIG_COLLECTION);
}

// Raw stored doc (secrets still encrypted), or null.
async function getEmailConfigRaw() {
  try {
    const col = await configCollection();
    return await col.findOne({ key: EMAIL_KEY });
  } catch (error) {
    Logger.error("getEmailConfigRaw failed: " + error.message, { stack: error.stack });
    return null;
  }
}

function safeDecrypt(value) {
  if (!value) return "";
  try {
    return decrypt(value);
  } catch {
    return "";
  }
}

// Effective config the email service should use to send mail (secrets decrypted).
// DB config wins; otherwise fall back to environment variables. Returns
// { provider: null } when nothing usable is configured.
async function getResolvedEmailConfig() {
  const raw = await getEmailConfigRaw();
  if (raw && raw.provider && raw.provider !== "none") {
    if (raw.provider === "resend") {
      const key = safeDecrypt(raw.resendApiKey);
      if (key) {
        return {
          provider: "resend",
          resendApiKey: key,
          from: raw.from || {},
          supportEmail: raw.supportEmail || "",
        };
      }
    } else if (raw.provider === "smtp") {
      const pass = safeDecrypt(raw.smtp && raw.smtp.pass);
      if (raw.smtp && raw.smtp.host && raw.smtp.user && pass) {
        return {
          provider: "smtp",
          smtp: {
            host: raw.smtp.host,
            port: raw.smtp.port || 587,
            user: raw.smtp.user,
            pass,
          },
          from: raw.from || {},
          supportEmail: raw.supportEmail || "",
        };
      }
    }
  }

  // ── Environment fallback ──
  if (process.env.RESEND_API_KEY) {
    return {
      provider: "resend",
      resendApiKey: process.env.RESEND_API_KEY,
      from: { name: process.env.FROM_NAME || "", email: process.env.FROM_EMAIL || "" },
      supportEmail: process.env.SUPPORT_EMAIL || "",
    };
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      provider: "smtp",
      smtp: {
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      from: {
        name: process.env.FROM_NAME || "",
        email: process.env.FROM_EMAIL || process.env.SMTP_USER,
      },
      supportEmail: process.env.SUPPORT_EMAIL || "",
    };
  }
  return { provider: null };
}

// Safe-to-return view: no secrets, just whether they are set.
async function getMaskedEmailConfig() {
  const raw = await getEmailConfigRaw();
  if (raw) {
    return {
      source: "database",
      provider: raw.provider || "none",
      smtp: {
        host: raw.smtp?.host || "",
        port: raw.smtp?.port || 587,
        user: raw.smtp?.user || "",
        pass: raw.smtp?.pass ? MASK : "",
      },
      resendApiKey: raw.resendApiKey ? MASK : "",
      from: { name: raw.from?.name || "", email: raw.from?.email || "" },
      supportEmail: raw.supportEmail || "",
      updatedAt: raw.updatedAt || null,
    };
  }
  // Reflect the env fallback (still no secrets) so the UI shows current state.
  const resolved = await getResolvedEmailConfig();
  return {
    source: resolved.provider ? "env" : "none",
    provider: resolved.provider || "none",
    smtp: {
      host: resolved.smtp?.host || "",
      port: resolved.smtp?.port || 587,
      user: resolved.smtp?.user || "",
      pass: resolved.smtp?.pass ? MASK : "",
    },
    resendApiKey: resolved.resendApiKey ? MASK : "",
    from: { name: resolved.from?.name || "", email: resolved.from?.email || "" },
    supportEmail: resolved.supportEmail || "",
    updatedAt: null,
  };
}

// Create/update the email config. Secret fields are only changed when a new,
// non-masked value is supplied (so a masked GET → PUT round-trip is safe).
// Returns the masked config. Throws on invalid provider requirements.
async function saveEmailConfig(input = {}) {
  const existing = await getEmailConfigRaw();

  const isNewSecret = (v) => typeof v === "string" && v.length > 0 && v !== MASK;

  const next = {
    key: EMAIL_KEY,
    provider: input.provider ?? existing?.provider ?? "none",
    smtp: {
      host: input.smtp?.host ?? existing?.smtp?.host ?? "",
      port: input.smtp?.port ?? existing?.smtp?.port ?? 587,
      user: input.smtp?.user ?? existing?.smtp?.user ?? "",
      pass: isNewSecret(input.smtp?.pass)
        ? encrypt(input.smtp.pass)
        : existing?.smtp?.pass ?? "",
    },
    resendApiKey: isNewSecret(input.resendApiKey)
      ? encrypt(input.resendApiKey)
      : existing?.resendApiKey ?? "",
    from: {
      name: input.from?.name ?? existing?.from?.name ?? "",
      email: input.from?.email ?? existing?.from?.email ?? "",
    },
    supportEmail: input.supportEmail ?? existing?.supportEmail ?? "",
    updatedAt: new Date(),
  };

  if (next.provider === "smtp" && (!next.smtp.host || !next.smtp.user || !next.smtp.pass)) {
    throw new Error("SMTP requires host, user, and password");
  }
  if (next.provider === "resend" && !next.resendApiKey) {
    throw new Error("Resend requires an API key");
  }

  const col = await configCollection();
  await col.updateOne({ key: EMAIL_KEY }, { $set: next }, { upsert: true });
  return getMaskedEmailConfig();
}

module.exports = {
  getResolvedEmailConfig,
  getMaskedEmailConfig,
  saveEmailConfig,
  getEmailConfigRaw,
};
