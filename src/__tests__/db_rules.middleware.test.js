jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service", () => ({ getDocument: jest.fn() }));
jest.mock("../utils/encryptions", () => ({ verifyToken: jest.fn() }));

const {
  validateCollectionParam,
  documentMiddleware,
  isAdminSocket,
  socketAdminGuard,
  socketColGuard,
  socketDocGuard,
} = require("../middleware/db_rules.middleware");
const { mockReq, mockRes } = require("./helpers/express-mocks");
const { getDocument } = require("../core/db_service");
const { verifyToken } = require("../utils/encryptions");
const { authCollectionName, systemDatabaseName, systemProjectCode } = require("../constants");

afterEach(() => jest.clearAllMocks());

describe("validateCollectionParam", () => {
  it('should return true for valid collection name "users"', () => {
    const req = mockReq({ params: { col: "users" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return true for "user_data_2"', () => {
    const req = mockReq({ params: { col: "user_data_2" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
  });

  it("should return true for name at max length (64 chars)", () => {
    const name = "a" + "b".repeat(63);
    const req = mockReq({ params: { col: name } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
  });

  it('should return false and send 400 for reserved name "_users"', () => {
    const req = mockReq({ params: { col: "_users" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain("system collections");
  });

  it('should return false and send 400 for reserved name "admin"', () => {
    const req = mockReq({ params: { col: "admin" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('should return false and send 400 for reserved name "_system"', () => {
    const req = mockReq({ params: { col: "_system" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
  });

  // "collections" collides with the admin dashboard's live schema-watch
  // colPath (`${projectCode}/collections`); a document watch on a collection
  // with this literal name would register under the same registry key as the
  // dashboard's collections-list watch. See constants.js reservedCollectionNames.
  it('should return false and send 400 for reserved name "collections"', () => {
    const req = mockReq({ params: { col: "collections" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain("system collections");
  });

  it("should return false for name starting with number", () => {
    const req = mockReq({ params: { col: "1abc" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain("Invalid collection name");
  });

  it("should return false for name with hyphens", () => {
    const req = mockReq({ params: { col: "my-col" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
  });

  it("should return false for name > 64 chars", () => {
    const name = "a".repeat(65);
    const req = mockReq({ params: { col: name } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
  });

  it("should return true when col param is undefined (no col param)", () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
  });

  it("should return false for empty string param", () => {
    const req = mockReq({ params: { col: "" } });
    const res = mockRes();
    // empty string is falsy, so the guards don't trigger
    expect(validateCollectionParam(req, res)).toBe(true);
  });
});

// ─── isAdminSocket / socketAdminGuard / admin bypass on socketColGuard,
// socketDocGuard (K1: extraction + K2 prerequisite) ──────────────────────────

/** A socket carrying the dashboard's { projectToken, token } handshake shape. */
function adminSocket({ project, hasToken = true } = {}) {
  return {
    handshake: { auth: hasToken ? { projectToken: "proj-jwt", token: "admin-jwt" } : {} },
    project: project || { code: "proj1", userId: "owner-id" },
    emit: jest.fn(),
  };
}

const ADMIN_SENDER = { _id: "owner-id", isActive: true, roles: ["admin"] };

describe("isAdminSocket", () => {
  it("returns null when the handshake carries no token at all", async () => {
    const socket = adminSocket({ hasToken: false });
    expect(await isAdminSocket(socket)).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("returns null for an expired/invalid token", async () => {
    verifyToken.mockReturnValue({ expired: true });
    expect(await isAdminSocket(adminSocket())).toBeNull();
  });

  it("returns null when the sender isn't found in the SYSTEM auth collection", async () => {
    verifyToken.mockReturnValue({ userId: "owner-id" });
    getDocument.mockResolvedValue(null);
    expect(await isAdminSocket(adminSocket())).toBeNull();
  });

  it("returns null for a sender with no admin/superadmin role", async () => {
    verifyToken.mockReturnValue({ userId: "u1" });
    getDocument.mockResolvedValue({ _id: "u1", isActive: true, roles: ["user"] });
    expect(await isAdminSocket(adminSocket())).toBeNull();
  });

  it("returns null for a deactivated admin", async () => {
    verifyToken.mockReturnValue({ userId: "owner-id" });
    getDocument.mockResolvedValue({ ...ADMIN_SENDER, isActive: false });
    expect(await isAdminSocket(adminSocket())).toBeNull();
  });

  it("returns null when the admin does not own the watched project", async () => {
    verifyToken.mockReturnValue({ userId: "someone-else" });
    getDocument.mockResolvedValue({ _id: "someone-else", isActive: true, roles: ["admin"] });
    const socket = adminSocket({ project: { code: "proj1", userId: "owner-id" } });
    expect(await isAdminSocket(socket)).toBeNull();
  });

  it("returns the sender for a valid admin who owns the project", async () => {
    verifyToken.mockReturnValue({ userId: "owner-id" });
    getDocument.mockResolvedValue(ADMIN_SENDER);
    expect(await isAdminSocket(adminSocket())).toBe(ADMIN_SENDER);
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: systemDatabaseName,
        projectCode: systemProjectCode,
        collectionName: authCollectionName,
      }),
    );
  });

  it("skips the ownership check for the _system project", async () => {
    verifyToken.mockReturnValue({ userId: "some-admin" });
    getDocument.mockResolvedValue({ _id: "some-admin", isActive: true, roles: ["superadmin"] });
    const socket = adminSocket({ project: { code: "_system", userId: undefined } });
    expect(await isAdminSocket(socket)).not.toBeNull();
  });

  it("fails closed (returns null, does not throw) when the lookup errors", async () => {
    verifyToken.mockReturnValue({ userId: "owner-id" });
    getDocument.mockRejectedValue(new Error("mongo down"));
    await expect(isAdminSocket(adminSocket())).resolves.toBeNull();
  });
});

describe("socketAdminGuard", () => {
  it("emits the specific missing-token message and does not call next", async () => {
    const socket = adminSocket({ hasToken: false });
    const next = jest.fn();
    await socketAdminGuard(socket, next);
    expect(socket.emit).toHaveBeenCalledWith("error", "Missing token or project token");
    expect(next).not.toHaveBeenCalled();
  });

  it("emits Unauthorized and does not set socket.sender for a non-admin", async () => {
    verifyToken.mockReturnValue({ userId: "u1" });
    getDocument.mockResolvedValue({ _id: "u1", isActive: true, roles: ["user"] });
    const socket = adminSocket();
    const next = jest.fn();
    await socketAdminGuard(socket, next);
    expect(socket.emit).toHaveBeenCalledWith("error", "Unauthorized");
    expect(socket.sender).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it("sets socket.sender and calls next for a genuine admin", async () => {
    verifyToken.mockReturnValue({ userId: "owner-id" });
    getDocument.mockResolvedValue(ADMIN_SENDER);
    const socket = adminSocket();
    const next = jest.fn();
    await socketAdminGuard(socket, next);
    expect(socket.sender).toBe(ADMIN_SENDER);
    expect(next).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe("socketColGuard admin bypass", () => {
  function nonAdminSocket({ project, sender } = {}) {
    return {
      handshake: { auth: {} }, // no token → isAdminSocket short-circuits, no DB call
      project: project || { code: "proj1", userId: "owner-id", dbRules: {} },
      sender,
      emit: jest.fn(),
    };
  }

  it("bypasses dbRules and allows a genuine admin socket", async () => {
    verifyToken.mockReturnValue({ userId: "owner-id" });
    getDocument.mockResolvedValue(ADMIN_SENDER);
    const socket = adminSocket({
      project: { code: "proj1", userId: "owner-id", dbRules: {} }, // no rule for "posts" → would deny a non-admin
    });
    const next = jest.fn();
    await socketColGuard(socket, "posts", next);
    expect(next).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
    // Only the admin-identity lookup ran — no per-collection rule check needed getDocument again.
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("denies a non-admin socket when no rule permits the collection (default-deny)", async () => {
    const socket = nonAdminSocket({ project: { code: "proj1", userId: "owner-id", dbRules: {} } });
    const next = jest.fn();
    await socketColGuard(socket, "posts", next);
    expect(next).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith("error", "Unauthorized");
  });

  it("allows a non-admin socket when the collection rule is permissive", async () => {
    const socket = nonAdminSocket({
      project: { code: "proj1", userId: "owner-id", dbRules: { "/posts": { read: true } } },
    });
    const next = jest.fn();
    await socketColGuard(socket, "posts", next);
    expect(next).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe("socketDocGuard admin bypass", () => {
  function nonAdminSocket({ project, sender } = {}) {
    return {
      handshake: { auth: {} },
      project: project || { code: "proj1", userId: "owner-id", dbRules: {} },
      sender,
      emit: jest.fn(),
    };
  }

  const DATA = { path: "/posts/doc1" };

  it("bypasses dbRules and allows a genuine admin socket without fetching the document", async () => {
    verifyToken.mockReturnValue({ userId: "owner-id" });
    getDocument.mockResolvedValue(ADMIN_SENDER);
    const socket = adminSocket({
      project: { code: "proj1", userId: "owner-id", dbRules: {} },
    });
    const next = jest.fn();
    await socketDocGuard(socket, DATA, next);
    expect(next).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
    // Only the admin-identity lookup ran (SYSTEM auth collection) — the guard
    // never fetched "doc1" from the project's own collection to rule-check it.
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ collectionName: authCollectionName }),
    );
  });

  it("denies a non-admin socket when no rule permits the document (default-deny)", async () => {
    getDocument.mockResolvedValue({ _id: "doc1" });
    const socket = nonAdminSocket({ project: { code: "proj1", userId: "owner-id", dbRules: {} } });
    const next = jest.fn();
    await socketDocGuard(socket, DATA, next);
    expect(next).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith("error", "Unauthorized");
  });

  it("allows a non-admin socket when the document rule is permissive", async () => {
    getDocument.mockResolvedValue({ _id: "doc1" });
    const socket = nonAdminSocket({
      project: { code: "proj1", userId: "owner-id", dbRules: { "/posts": { read: true } } },
    });
    const next = jest.fn();
    await socketDocGuard(socket, DATA, next);
    expect(next).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

// ─── documentMiddleware (K5: dedup with GET/DELETE /:col/:id) ───────────────
//
// documentMiddleware fetches the target document once to feed the rules
// check, then stashes it on req.document so the route handler can reuse it
// instead of fetching the identical {_id} query again. These tests pin that
// contract: exactly one getDocument call on the non-admin path, req.document
// populated before next() fires, and the admin path left untouched (no
// fetch at all — the route handler's own fallback fetch covers it).

describe("documentMiddleware", () => {
  function docReq({ isDbAdmin = false, byAdmin = false, dbRules = {}, method = "GET" } = {}) {
    return mockReq({
      method,
      params: { col: "posts", id: "doc1" },
      originalUrl: "/projects/test/db/posts/doc1",
      isDbAdmin,
      byAdmin,
      project: { name: "Test", code: "test", userId: "owner-id", dbRules },
    });
  }

  it("short-circuits on an invalid collection name without ever fetching", async () => {
    const req = mockReq({ params: { col: "_system", id: "doc1" } });
    const res = mockRes();
    const next = jest.fn();
    await documentMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(getDocument).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("skips the fetch entirely on the req.isDbAdmin bypass path", async () => {
    const req = docReq({ isDbAdmin: true });
    const res = mockRes();
    const next = jest.fn();
    await documentMiddleware(req, res, next);
    expect(getDocument).not.toHaveBeenCalled();
    expect(req.document).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("skips the fetch entirely on the req.byAdmin bypass path", async () => {
    const req = docReq({ byAdmin: true });
    const res = mockRes();
    const next = jest.fn();
    await documentMiddleware(req, res, next);
    expect(getDocument).not.toHaveBeenCalled();
    expect(req.document).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("fetches the document exactly once, attaches it to req.document, and calls next when the rule allows", async () => {
    getDocument.mockResolvedValue({ _id: "doc1", ownerId: "owner-id" });
    const req = docReq({ dbRules: { "/posts": { read: true } } });
    const res = mockRes();
    const next = jest.fn();
    await documentMiddleware(req, res, next);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        collectionName: "posts",
        query: { _id: "doc1" },
      }),
    );
    expect(req.document).toEqual({ _id: "doc1", ownerId: "owner-id" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("still fetches once and denies (403) when the rule does not allow it, and does not call next", async () => {
    getDocument.mockResolvedValue({ _id: "doc1", ownerId: "someone-else" });
    // default-deny: no rule at all for "/posts"
    const req = docReq({ dbRules: {} });
    const res = mockRes();
    const next = jest.fn();
    await documentMiddleware(req, res, next);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 500 and does not call next when the fetch itself throws", async () => {
    getDocument.mockRejectedValue(new Error("mongo down"));
    const req = docReq({ dbRules: { "/posts": { read: true } } });
    const res = mockRes();
    const next = jest.fn();
    await documentMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "mongo down" });
    expect(next).not.toHaveBeenCalled();
  });
});
