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
}

module.exports = { validateEnv };
