// Validates required environment variables at startup
// Call this before connecting to any service

require("dotenv").config();

function validateEnv() {
  // ADMIN_EMAIL / ADMIN_PASS are intentionally NOT required: the single admin is
  // normally created via the first-run /setup wizard. They remain supported as an
  // optional headless-seed override (see src/seeds/createAdmin.js).
  const required = [
    { key: "JWT_SECRET", hint: "Secret for JWT signing (set separately from ENCRYPTION_KEY)" },
    { key: "ENCRYPTION_KEY", hint: "Key for legacy AES-256-CBC encryption" },
    { key: "MONGODB_URI", hint: "MongoDB connection string (e.g. mongodb://localhost:27017)" },
  ];

  const missing = [];
  for (const { key, hint } of required) {
    if (!process.env[key] || process.env[key].trim() === "") {
      missing.push(`  - ${key}: ${hint}`);
    }
  }

  if (missing.length > 0) {
    console.error("\nMissing required environment variables:\n" + missing.join("\n"));
    console.error("\nCopy .env.example to .env and fill in the values.\n");
    process.exit(1);
  }

  warnOnWeakSecrets();
}

// Deliberately a WARNING, never a refusal to boot.
//
// A short secret is a real weakness — every auth token, project token and
// verification link in the system is signed with JWT_SECRET, so a brute-forcible
// one is equivalent to handing out admin. But refusing to start is the wrong
// remedy for a system that is already running: it converts a latent weakness
// into an immediate outage on the next restart, and the fix (rotating the
// secret) invalidates every token in circulation at once — including the project
// tokens compiled into deployed browser bundles, which cannot re-login their way
// out of it. Rotation is a planned migration, not something to be forced by a
// failed deploy at 3am.
//
// So: say it loudly, every boot, and let the operator schedule the rotation.
const MIN_SECRET_LENGTH = 32;

function warnOnWeakSecrets() {
  const secrets = [
    { key: "JWT_SECRET", value: process.env.JWT_SECRET },
    { key: "ENCRYPTION_KEY", value: process.env.ENCRYPTION_KEY },
  ];

  for (const { key, value } of secrets) {
    if (value && value.length < MIN_SECRET_LENGTH) {
      console.warn(
        `WARNING: ${key} is ${value.length} characters; ${MIN_SECRET_LENGTH}+ is recommended. ` +
          "Plan a rotation — note that rotating JWT_SECRET invalidates every issued " +
          "token, including project tokens already shipped in client bundles.",
      );
    }
  }

  if (
    process.env.JWT_SECRET &&
    process.env.JWT_SECRET === process.env.ENCRYPTION_KEY
  ) {
    console.warn(
      "WARNING: JWT_SECRET and ENCRYPTION_KEY are identical. They protect " +
        "different things and should be independent values.",
    );
  }

  // The CORS middleware's permissive fallbacks — reflect ANY origin, with
  // credentials, when origins are unconfigured — are already gated on
  // NODE_ENV !== "production" and are correct for local work. The failure mode
  // is a real deployment that simply never set NODE_ENV, which silently leaves
  // those fallbacks switched on. Nothing here can tell "deployed" from "local",
  // so state the consequence and let the operator judge.
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `NOTE: NODE_ENV is "${process.env.NODE_ENV || "unset"}", not "production". ` +
        "CORS will reflect any origin with credentials for projects that have no " +
        "allowedOrigins configured. Set NODE_ENV=production when deploying.",
    );
  }
}

module.exports = { validateEnv, warnOnWeakSecrets };
