// Regression tests for the 2026-06-27 security hardening pass.
// Each block maps to a finding from the FlexDocs security assessment.

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const jwt = require("jsonwebtoken");

describe("security fixes", () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, JWT_SECRET: "test-secret" };
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
  });

  // ── H1: JWT algorithm pinning ──────────────────────────────────────────────
  describe("JWT algorithm pinning (encryptions)", () => {
    it("signs tokens with HS256", () => {
      const { getToken } = require("../utils/encryptions");
      const token = getToken({ userId: "u1", project: "p1" });
      const header = jwt.decode(token, { complete: true }).header;
      expect(header.alg).toBe("HS256");
    });

    it("rejects an alg:none token", () => {
      const { verifyToken } = require("../utils/encryptions");
      const noneToken = jwt.sign({ userId: "u1" }, "", { algorithm: "none" });
      expect(verifyToken(noneToken)).toBeNull();
    });

    it("accepts a valid HS256 token", () => {
      const { getToken, verifyToken } = require("../utils/encryptions");
      const token = getToken({ userId: "u1", project: "p1" });
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe("u1");
      expect(decoded.project).toBe("p1");
    });
  });

  // ── C4: Host-header poisoning of reset/verify links ────────────────────────
  describe("getPublicBaseUrl (Host poisoning)", () => {
    function makeReq(host) {
      return { protocol: "http", get: (h) => (h === "host" ? host : undefined) };
    }

    it("uses PUBLIC_API_URL when configured, ignoring the Host header", () => {
      process.env.PUBLIC_API_URL = "https://api.example.com";
      const { getPublicBaseUrl } = require("../utils/helper");
      expect(getPublicBaseUrl(makeReq("evil.com"))).toBe("https://api.example.com");
    });

    it("rejects a forged Host not in the allowlist and falls back safely", () => {
      delete process.env.PUBLIC_API_URL;
      process.env.ALLOWED_ORIGINS = "http://admin.example.com";
      const { getPublicBaseUrl } = require("../utils/helper");
      expect(getPublicBaseUrl(makeReq("evil.com"))).toBe("http://admin.example.com");
    });

    it("trusts a Host that matches an allowlisted origin", () => {
      delete process.env.PUBLIC_API_URL;
      process.env.ALLOWED_ORIGINS = "http://api.example.com";
      const { getPublicBaseUrl } = require("../utils/helper");
      expect(getPublicBaseUrl(makeReq("api.example.com"))).toBe("http://api.example.com");
    });
  });

  // ── Low: request-id log injection ──────────────────────────────────────────
  describe("requestId header sanitization", () => {
    function run(headerVal) {
      const { requestId } = require("../middleware/request_id.middleware");
      const req = { headers: headerVal === undefined ? {} : { "x-request-id": headerVal } };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();
      requestId(req, res, next);
      return req.id;
    }

    it("keeps a safe client-provided id", () => {
      expect(run("abc-123_DEF.4")).toBe("abc-123_DEF.4");
    });

    it("replaces an id containing CRLF / log-injection chars", () => {
      const id = run("evil\r\nInject: x");
      expect(id).not.toContain("\n");
      expect(id).toMatch(/^[0-9a-f-]{36}$/); // generated UUID
    });

    it("generates an id when none is provided", () => {
      expect(run(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ── C1: default-DENY rules engine ──────────────────────────────────────────
  describe("default-DENY rules engine", () => {
    const DbRulesService = require("../core/db_rules_service");
    it("denies an un-ruled collection", async () => {
      const svc = new DbRulesService({});
      expect(await svc.check({ action: "read", path: "/secrets", doc: null })).toBe(false);
    });
    it("denies an action not declared in a rule object", async () => {
      const svc = new DbRulesService({ "/posts": { read: true } });
      expect(await svc.check({ action: "delete", path: "/posts", doc: null })).toBe(false);
    });
    it("still allows an explicitly permitted action", async () => {
      const svc = new DbRulesService({ "/posts": { read: true } });
      expect(await svc.check({ action: "read", path: "/posts", doc: null })).toBe(true);
    });
  });
});
