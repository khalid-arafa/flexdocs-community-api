jest.mock("../utils/logger", () => ({ log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

// In-memory _config collection
const store = {};
jest.mock("../core/client", () => ({
  getUserDB: jest.fn(async () => ({
    collection: () => ({
      findOne: async (q) => store[q.key] || null,
      updateOne: async (q, upd) => {
        store[q.key] = { ...(store[q.key] || {}), ...upd.$set };
        return { acknowledged: true };
      },
    }),
  })),
}));

// Reversible fake crypto so we can assert encrypt-at-rest + decrypt-on-read
jest.mock("../utils/encryptions", () => ({
  encrypt: (s) => `ENC(${s})`,
  decrypt: (s) => {
    if (typeof s === "string" && s.startsWith("ENC(") && s.endsWith(")")) return s.slice(4, -1);
    throw new Error("bad ciphertext");
  },
}));

const {
  getResolvedEmailConfig,
  getMaskedEmailConfig,
  saveEmailConfig,
  getEmailConfigRaw,
} = require("../core/config_service");

const EMAIL_ENV = ["RESEND_API_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "FROM_NAME", "FROM_EMAIL", "SUPPORT_EMAIL"];

describe("config_service (email)", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    EMAIL_ENV.forEach((k) => delete process.env[k]);
  });

  describe("getResolvedEmailConfig", () => {
    it("returns provider:null when nothing is configured", async () => {
      expect(await getResolvedEmailConfig()).toEqual({ provider: null });
    });

    it("falls back to SMTP env vars when no DB config", async () => {
      process.env.SMTP_HOST = "smtp.test"; process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
      const cfg = await getResolvedEmailConfig();
      expect(cfg.provider).toBe("smtp");
      expect(cfg.smtp).toMatchObject({ host: "smtp.test", user: "u", pass: "p", port: 587 });
    });

    it("falls back to Resend env when set", async () => {
      process.env.RESEND_API_KEY = "re_env";
      const cfg = await getResolvedEmailConfig();
      expect(cfg.provider).toBe("resend");
      expect(cfg.resendApiKey).toBe("re_env");
    });

    it("DB config wins over env and decrypts the secret", async () => {
      process.env.RESEND_API_KEY = "re_env";
      await saveEmailConfig({ provider: "smtp", smtp: { host: "h", user: "user", pass: "secret" }, from: { email: "a@b.com" } });
      const cfg = await getResolvedEmailConfig();
      expect(cfg.provider).toBe("smtp");
      expect(cfg.smtp.pass).toBe("secret"); // decrypted
    });
  });

  describe("saveEmailConfig", () => {
    it("encrypts the SMTP password at rest", async () => {
      await saveEmailConfig({ provider: "smtp", smtp: { host: "h", user: "u", pass: "topsecret" } });
      const raw = await getEmailConfigRaw();
      expect(raw.smtp.pass).toBe("ENC(topsecret)");
    });

    it("rejects SMTP without host/user/pass", async () => {
      await expect(saveEmailConfig({ provider: "smtp", smtp: { host: "h" } })).rejects.toThrow(/SMTP requires/);
    });

    it("rejects Resend without an API key", async () => {
      await expect(saveEmailConfig({ provider: "resend" })).rejects.toThrow(/Resend requires/);
    });

    it("keeps the existing secret when a new one is not provided", async () => {
      await saveEmailConfig({ provider: "smtp", smtp: { host: "h", user: "u", pass: "orig" } });
      // update only the host, omit pass
      await saveEmailConfig({ provider: "smtp", smtp: { host: "h2", user: "u" } });
      const cfg = await getResolvedEmailConfig();
      expect(cfg.smtp.host).toBe("h2");
      expect(cfg.smtp.pass).toBe("orig"); // preserved
    });

    it("does not overwrite the secret when the masked placeholder is sent back", async () => {
      await saveEmailConfig({ provider: "resend", resendApiKey: "re_real" });
      await saveEmailConfig({ provider: "resend", resendApiKey: "********" });
      const cfg = await getResolvedEmailConfig();
      expect(cfg.resendApiKey).toBe("re_real");
    });
  });

  describe("getMaskedEmailConfig", () => {
    it("masks secrets and reports source", async () => {
      await saveEmailConfig({ provider: "smtp", smtp: { host: "h", user: "u", pass: "p" } });
      const masked = await getMaskedEmailConfig();
      expect(masked.source).toBe("database");
      expect(masked.provider).toBe("smtp");
      expect(masked.smtp.host).toBe("h");
      expect(masked.smtp.pass).toBe("********");
      expect(masked).not.toHaveProperty("smtp.passPlain");
    });

    it("reports source 'none' when nothing configured", async () => {
      const masked = await getMaskedEmailConfig();
      expect(masked.source).toBe("none");
      expect(masked.provider).toBe("none");
    });
  });
});
