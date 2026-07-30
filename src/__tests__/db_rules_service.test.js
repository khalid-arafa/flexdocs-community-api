jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const DbRulesService = require("../core/db_rules_service");
const Logger = require("../utils/logger");

describe("DbRulesService", () => {
  let service;

  beforeEach(() => {
    service = new DbRulesService({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Always restore real timers in case a test used fake timers
    jest.useRealTimers();
  });

  // ── constructor / setRules / getRules ──────────────────────────────────────

  describe("constructor and rule management", () => {
    it("should initialise with empty rules when none provided", () => {
      const s = new DbRulesService();
      expect(s.getRules()).toEqual({});
    });

    it("should store provided rules", () => {
      const rules = { "/users": true };
      const s = new DbRulesService(rules);
      expect(s.getRules()).toEqual(rules);
    });

    it("setRules() should replace the current rule set", () => {
      service.setRules({ "/posts": false });
      expect(service.getRules()).toEqual({ "/posts": false });
    });

    it("addPathRules() should add rules for a specific path", () => {
      service.addPathRules("/docs", { read: true, add: false });
      expect(service.getRules()["/docs"]).toEqual({ read: true, add: false });
    });
  });

  // ── _evaluateRule ─────────────────────────────────────────────────────────

  describe("_evaluateRule()", () => {
    it("should return false when the path rule is undefined (default-DENY)", async () => {
      service.setRules({});
      const result = await service._evaluateRule("/unknown", "read", null, null, null);
      expect(result).toBe(false);
    });

    it("should return true for a top-level boolean true rule", async () => {
      service.setRules({ "/users": true });
      const result = await service._evaluateRule("/users", "read", null, null, null);
      expect(result).toBe(true);
    });

    it("should return false for a top-level boolean false rule", async () => {
      service.setRules({ "/users": false });
      const result = await service._evaluateRule("/users", "read", null, null, null);
      expect(result).toBe(false);
    });

    it("should return true when action-level boolean is true", async () => {
      service.setRules({ "/posts": { read: true, add: false } });
      const result = await service._evaluateRule("/posts", "read", null, null, null);
      expect(result).toBe(true);
    });

    it("should return false when action-level boolean is false", async () => {
      service.setRules({ "/posts": { read: true, add: false } });
      const result = await service._evaluateRule("/posts", "add", null, null, null);
      expect(result).toBe(false);
    });

    it("should return false (default-DENY) when action is not defined in the rule object", async () => {
      service.setRules({ "/posts": { read: true } });
      // delete action not defined → denied
      const result = await service._evaluateRule("/posts", "delete", null, null, null);
      expect(result).toBe(false);
    });

    it("should evaluate a JEXL expression that resolves to true", async () => {
      service.setRules({ "/posts": { read: "user.role == 'admin'" } });
      const result = await service._evaluateRule("/posts", "read", { role: "admin" }, null, null);
      expect(result).toBe(true);
    });

    it("should evaluate a JEXL expression that resolves to false", async () => {
      service.setRules({ "/posts": { read: "user.role == 'admin'" } });
      const result = await service._evaluateRule("/posts", "read", { role: "viewer" }, null, null);
      expect(result).toBe(false);
    });

    it("should pass doc and body into the JEXL context", async () => {
      service.setRules({ "/posts": { update: "doc.owner == user.uid" } });
      const result = await service._evaluateRule(
        "/posts", "update",
        { uid: "u1" },
        { owner: "u1" }, // doc
        null
      );
      expect(result).toBe(true);
    });

    it("should return false when the JEXL expression has a syntax error", async () => {
      service.setRules({ "/posts": { read: "user.role ==" } }); // invalid JEXL
      const result = await service._evaluateRule("/posts", "read", { role: "admin" }, null, null);
      expect(result).toBe(false);
    });

    it("should return false when JEXL evaluation times out after 100 ms", async () => {
      jest.useFakeTimers();
      const jexl = require("jexl");
      // The service compiles once and evaluates the cached AST, so the stub has
      // to replace the compiled expression's eval — not jexl.eval, which is
      // never reached.
      jest.spyOn(jexl, "compile").mockReturnValue({
        eval: () => new Promise(() => {}),
      });

      service.setRules({ "/posts": { read: "slowExpression" } });
      const resultPromise = service._evaluateRule("/posts", "read", null, null, null);

      // Advance past the 100 ms timeout
      jest.advanceTimersByTime(150);

      const result = await resultPromise;
      expect(result).toBe(false);
      expect(Logger.error).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
        expect.anything(),
      );
    });
  });

  // ── compiled-expression cache ─────────────────────────────────────────────

  describe("compiled expression cache", () => {
    it("should compile a repeated expression only once", async () => {
      const jexl = require("jexl");
      const compile = jest.spyOn(jexl, "compile");
      service.setRules({ "/cached": { read: "user.tier == 'compile-once'" } });
      for (let i = 0; i < 20; i++) {
        await service._evaluateRule("/cached", "read", { tier: "compile-once" }, null, null);
      }
      expect(compile).toHaveBeenCalledTimes(1);
    });

    it("should return the same verdict on every evaluation of one expression", async () => {
      service.setRules({ "/posts": { read: "user.role == 'admin'" } });
      for (let i = 0; i < 100; i++) {
        expect(
          await service._evaluateRule("/posts", "read", { role: "admin" }, null, null)
        ).toBe(true);
        expect(
          await service._evaluateRule("/posts", "read", { role: "viewer" }, null, null)
        ).toBe(false);
      }
    });

    it("should not leak context between evaluations of a cached expression", async () => {
      service.setRules({ "/posts": { update: "doc.owner == user.uid" } });
      const first = await service._evaluateRule(
        "/posts", "update", { uid: "u1" }, { owner: "u1" }, null
      );
      const second = await service._evaluateRule(
        "/posts", "update", { uid: "u2" }, { owner: "u1" }, null
      );
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it("should deny a malformed expression on every evaluation, never throwing", async () => {
      service.setRules({ "/posts": { read: "user.role ==" } });
      for (let i = 0; i < 5; i++) {
        await expect(
          service._evaluateRule("/posts", "read", { role: "admin" }, null, null)
        ).resolves.toBe(false);
      }
    });

    it("should keep evaluating correctly past the cache ceiling", async () => {
      const MAX_COMPILED_EXPRESSIONS = 500;
      for (let i = 0; i < MAX_COMPILED_EXPRESSIONS + 50; i++) {
        service.setRules({ "/bulk": { read: `user.n == ${i}` } });
        expect(await service._evaluateRule("/bulk", "read", { n: i }, null, null)).toBe(true);
      }
      // The earliest expression has been evicted; it must recompile rather than
      // return a stale verdict.
      service.setRules({ "/bulk": { read: "user.n == 0" } });
      expect(await service._evaluateRule("/bulk", "read", { n: 0 }, null, null)).toBe(true);
      expect(await service._evaluateRule("/bulk", "read", { n: 1 }, null, null)).toBe(false);
    });
  });

  // ── isCollectionAllowed ───────────────────────────────────────────────────

  describe("isCollectionAllowed()", () => {
    it("should return false for invalid (non-string) path", async () => {
      const result = await service.isCollectionAllowed({ path: null, action: "read" });
      expect(result).toBe(false);
    });

    it("should return false for empty path", async () => {
      const result = await service.isCollectionAllowed({ path: "", action: "read" });
      expect(result).toBe(false);
    });

    it("should match the first path segment as collection name", async () => {
      service.setRules({ "/posts": { read: true } });
      const result = await service.isCollectionAllowed({
        path: "/posts",
        action: "read",
        user: null,
      });
      expect(result).toBe(true);
    });

    it("should return false when no rule matches (default-DENY)", async () => {
      service.setRules({ "/posts": false });
      const result = await service.isCollectionAllowed({
        path: "/unrelated",
        action: "read",
      });
      expect(result).toBe(false);
    });

    it("should evaluate a JEXL rule with user context", async () => {
      service.setRules({ "/private": { read: "user != null" } });
      const allowed = await service.isCollectionAllowed({
        path: "/private",
        action: "read",
        user: { uid: "u1" },
      });
      const denied = await service.isCollectionAllowed({
        path: "/private",
        action: "read",
        user: null,
      });
      expect(allowed).toBe(true);
      expect(denied).toBe(false);
    });
  });

  // ── isDocumentAllowed ─────────────────────────────────────────────────────

  describe("isDocumentAllowed()", () => {
    it("should return false for invalid path", async () => {
      const result = await service.isDocumentAllowed({ path: null, action: "read" });
      expect(result).toBe(false);
    });

    it("should return false when path has fewer than two segments", async () => {
      const result = await service.isDocumentAllowed({ path: "/posts", action: "read" });
      expect(result).toBe(false);
    });

    it("should match a specific document path", async () => {
      service.setRules({ "/posts/doc-123": { read: true } });
      const result = await service.isDocumentAllowed({
        path: "/posts/doc-123",
        action: "read",
      });
      expect(result).toBe(true);
    });

    it("should match a dynamic [id] path pattern", async () => {
      service.setRules({ "/posts/[id]": { read: true } });
      const result = await service.isDocumentAllowed({
        path: "/posts/any-doc-id",
        action: "read",
      });
      expect(result).toBe(true);
    });

    it("should fall back to collection-level rule when no document rule matches", async () => {
      service.setRules({ "/posts": { read: true } });
      const result = await service.isDocumentAllowed({
        path: "/posts/doc-abc",
        action: "read",
      });
      expect(result).toBe(true);
    });

    it("should prefer specific doc rule over dynamic [id] rule", async () => {
      service.setRules({
        "/posts/specific-id": { read: false },
        "/posts/[id]": { read: true },
      });
      const result = await service.isDocumentAllowed({
        path: "/posts/specific-id",
        action: "read",
      });
      expect(result).toBe(false);
    });

    it("should prefer dynamic [id] rule over the collection rule", async () => {
      service.setRules({
        "/posts": { read: true },
        "/posts/[id]": { read: false },
      });
      const result = await service.isDocumentAllowed({
        path: "/posts/doc-1",
        action: "read",
      });
      expect(result).toBe(false);
    });

    it("should deny when the [id] rule object omits the action", async () => {
      service.setRules({ "/posts/[id]": { read: true } });
      const result = await service.isDocumentAllowed({
        path: "/posts/doc-1",
        action: "delete",
      });
      expect(result).toBe(false);
    });

    it("should evaluate doc.owner == user.uid expression", async () => {
      service.setRules({ "/posts/[id]": { update: "doc.owner == user.uid" } });
      const allowed = await service.isDocumentAllowed({
        path: "/posts/doc-1",
        action: "update",
        user: { uid: "u1" },
        doc: { owner: "u1" },
      });
      const denied = await service.isDocumentAllowed({
        path: "/posts/doc-1",
        action: "update",
        user: { uid: "u2" },
        doc: { owner: "u1" },
      });
      expect(allowed).toBe(true);
      expect(denied).toBe(false);
    });
  });

  // ── check() ───────────────────────────────────────────────────────────────

  describe("check()", () => {
    it("should delegate to isDocumentAllowed when doc is provided", async () => {
      service.setRules({ "/posts": { read: true } });
      jest.spyOn(service, "isDocumentAllowed");
      await service.check({
        action: "read",
        path: "/posts/doc-1",
        user: null,
        doc: { _id: "doc-1" },
        body: null,
      });
      expect(service.isDocumentAllowed).toHaveBeenCalled();
    });

    it("should delegate to isCollectionAllowed when doc is null/undefined", async () => {
      service.setRules({ "/posts": { read: true } });
      jest.spyOn(service, "isCollectionAllowed");
      await service.check({ action: "read", path: "/posts", user: null, doc: null, body: null });
      expect(service.isCollectionAllowed).toHaveBeenCalled();
    });

    it("should return false and log on unexpected error", async () => {
      jest.spyOn(service, "isCollectionAllowed").mockRejectedValue(new Error("Unexpected!"));
      const result = await service.check({ action: "read", path: "/posts", doc: null });
      expect(result).toBe(false);
    });
  });

  // ── middleware() ──────────────────────────────────────────────────────────

  describe("middleware()", () => {
    const makeReq = (overrides = {}) => ({
      method: "GET",
      originalUrl: "/projects/testproj/db/posts",
      project: { code: "testproj" },
      user: null,
      doc: null,
      body: {},
      ...overrides,
    });
    const makeRes = () => {
      const res = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    it("should call next() when access is allowed", async () => {
      service.setRules({ "/posts": { read: true } });
      const mw = service.middleware();
      const next = jest.fn();
      await mw(makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    it("should call onUnauthorized when access is denied", async () => {
      service.setRules({ "/posts": { read: false } });
      const onUnauthorized = jest.fn();
      const mw = service.middleware({ onUnauthorized });
      const next = jest.fn();
      await mw(makeReq(), makeRes(), next);
      expect(next).not.toHaveBeenCalled();
      expect(onUnauthorized).toHaveBeenCalled();
    });

    it("should respond with 500 on unexpected middleware error", async () => {
      jest.spyOn(service, "isCollectionAllowed").mockRejectedValue(new Error("crash"));
      const mw = service.middleware();
      const next = jest.fn();
      const res = makeRes();
      await mw(makeReq(), res, next);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
