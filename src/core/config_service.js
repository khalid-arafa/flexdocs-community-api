// Runtime-editable system configuration (currently: email/SMTP + Resend).
// Stored in the _system database's _config collection under { key: "email" }.
// Secrets (SMTP password, Resend API key) are encrypted at rest with
// ENCRYPTION_KEY and never returned by the masked getter. If no DB config is
// present, email settings fall back to the corresponding environment variables.

const { getUserDB } = require("./client");
const { encryptSecret, decryptSecret } = require("../utils/encryptions");
const { systemDatabaseName, systemProjectCode } = require("../constants");
const Logger = require("../utils/logger");

const CONFIG_COLLECTION = "_config";
const EMAIL_KEY = "email";
const MASK = "********";

// Parse a host as an IPv4 literal in ANY of the encodings the OS resolver
// accepts (dotted-decimal, dotted with hex/octal octets, or a single
// decimal/hex/octal 32-bit integer). Returns [a,b,c,d] or null if it isn't an
// IPv4 literal (i.e. a real hostname).
function parseFlexibleIPv4(host) {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (p === "") return null;
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // contains non-numeric → hostname, not an IP literal
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // inet_aton semantics: the final part fills all remaining low-order bytes.
  let value;
  if (nums.length === 1) value = nums[0];
  else if (nums.length === 2) value = nums[0] * 2 ** 24 + nums[1];
  else if (nums.length === 3) value = nums[0] * 2 ** 24 + nums[1] * 2 ** 16 + nums[2];
  else value = nums[0] * 2 ** 24 + nums[1] * 2 ** 16 + nums[2] * 2 ** 8 + nums[3];
  if (value < 0 || value > 0xffffffff) return null;
  return [
    Math.floor(value / 2 ** 24) % 256,
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  ];
}

function isBlockedIPv4([a, b, c, d]) {
  return (
    a === 0 ||
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast / reserved
  );
}

// Reject SMTP hosts that point at loopback / link-local / private ranges (SSRF
// guard): an admin shouldn't be able to aim the mail client at the cloud
// metadata endpoint or internal services. Real hostnames are allowed (resolved
// at connect time — DNS-rebinding to an internal IP is out of scope for this
// literal guard); IP literals in dangerous ranges are blocked across all the
// encodings the resolver accepts.
function assertSafeSmtpHost(host) {
  let h = String(host || "").trim().toLowerCase();
  if (!h) throw new Error("SMTP host is required");

  // Normalize: strip IPv6 brackets and a single trailing dot.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);

  if (h === "localhost" || h.endsWith(".localhost")) {
    throw new Error("SMTP host is not allowed");
  }

  // IPv6 literal (contains a colon).
  if (h.includes(":")) {
    // Unwrap IPv4-mapped/embedded addresses: ::ffff:127.0.0.1 etc.
    const tail = h.slice(h.lastIndexOf(":") + 1);
    if (tail.includes(".")) {
      const v4 = parseFlexibleIPv4(tail);
      if (v4 && isBlockedIPv4(v4)) throw new Error("SMTP host is not allowed");
    }
    // Loopback (::1 / 0:0:..:1), unspecified (::), link-local (fe80::/10),
    // unique-local (fc00::/7 → starts fc/fd).
    const compact = h.replace(/(^|:)0+(?=[0-9a-f])/g, "$1");
    if (
      h === "::1" ||
      h === "::" ||
      compact === "::1" ||
      h.startsWith("fe8") ||
      h.startsWith("fe9") ||
      h.startsWith("fea") ||
      h.startsWith("feb") ||
      h.startsWith("fc") ||
      h.startsWith("fd")
    ) {
      throw new Error("SMTP host is not allowed");
    }
    return;
  }

  // IPv4 literal in any encoding.
  const v4 = parseFlexibleIPv4(h);
  if (v4 && isBlockedIPv4(v4)) {
    throw new Error("SMTP host is not allowed");
  }
}

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
    return decryptSecret(value);
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
        ? encryptSecret(input.smtp.pass)
        : existing?.smtp?.pass ?? "",
    },
    resendApiKey: isNewSecret(input.resendApiKey)
      ? encryptSecret(input.resendApiKey)
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
  if (next.provider === "smtp") assertSafeSmtpHost(next.smtp.host);
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
  assertSafeSmtpHost,
};
