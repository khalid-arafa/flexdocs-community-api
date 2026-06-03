jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const DbRulesService = require("../core/db_rules_service");

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
    it("should return true when the path rule is undefined (permissive default)", async () => {
      service.setRules({});
      const result = await service._evaluateRule("/unknown", "read", null, null, null);
      expect(result).toBe(true);
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

    it("should return true (permissive) when action is not defined in the rule object", async () => {
      service.setRules({ "/posts": { read: true } });
      // delete action not defined → permissive
      const result = await service._evaluateRule("/posts", "delete", null, null, null);
      expect(result).toBe(true);
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
      // Make jexl.eval never resolve
      jest.spyOn(jexl, "eval").mockImplementation(() => new Promise(() => {}));

      service.setRules({ "/posts": { read: "slowExpression" } });
      const resultPromise = service._evaluateRule("/posts", "read", null, null, null);

      // Advance past the 100 ms timeout
      jest.advanceTimersByTime(150);

      const result = await resultPromise;
      expect(result).toBe(false);
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

    it("should return true when no rule matches (permissive default)", async () => {
      service.setRules({ "/posts": false });
      const result = await service.isCollectionAllowed({
        path: "/unrelated",
        action: "read",
      });
      expect(result).toBe(true);
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
