// Wave 1 of the HTTP-layer hardening plan. Four unrelated fixes share this file
// because each is small and none warrants a suite of its own.
//
//   #2  ownership gate on project-scoped system routes
//   #3  admin session tokens no longer accepted from the query string
//   #6  the first-admin bootstrap is claimed atomically, not check-then-create
//   #7  malformed ObjectIds are rejected instead of silently matching nothing

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

describe("#2 requireProjectOwner", () => {
  // Exercised through the middleware's own contract rather than a mounted
  // router: the guard is the unit, and wiring it into all nine routes is
  // asserted separately below by reading the route table.
  const projectsRoutes = require("../system/projects.routes");

  function layersFor(method, path) {
    return projectsRoutes.stack
      .filter((l) => l.route && l.route.path === path && l.route.methods[method])
      .flatMap((l) => l.route.stack.map((s) => s.handle.name));
  }

  const GUARDED = [
    ["get", "/:projectCode/creds"],
    ["post", "/:projectCode/creds"],
    ["delete", "/:projectCode/creds/:id"],
    ["get", "/:projectCode/db/rules"],
    ["put", "/:projectCode/db/rules"],
    ["get", "/:projectCode/storage/rules"],
    ["put", "/:projectCode/storage/rules"],
    ["get", "/:projectCode/auth/rules"],
    ["put", "/:projectCode/auth/rules"],
  ];

  it.each(GUARDED)(
    "%s %s runs requireProjectOwner",
    (method, path) => {
      expect(layersFor(method, path)).toContain("requireProjectOwner");
    },
  );

  it("guards every route that can read or write credentials or rules", () => {
    // A new /:projectCode/... route that touches creds or rules must be added to
    // GUARDED above; this catches one being added without the gate.
    const sensitive = projectsRoutes.stack
      .filter(
        (l) =>
          l.route &&
          /^\/:projectCode\/.*(creds|rules)/.test(l.route.path),
      )
      .map((l) => l.route.path);
    const guardedPaths = new Set(GUARDED.map(([, p]) => p));
    for (const path of sensitive) expect(guardedPaths.has(path)).toBe(true);
  });
});

describe("#3 admin tokens are not read from the query string", () => {
  // Behavioural, not a source grep: what matters is that a token presented in
  // the URL does not authenticate, however the middleware is written.
  const SESSION = { userId: "u1", roles: ["admin"] };

  function loadMiddleware() {
    jest.resetModules();
    jest.doMock("../utils/encryptions", () => ({
      verifyToken: jest.fn((t) => (t === "GOOD" ? { ...SESSION } : null)),
    }));
    jest.doMock("../core/db_service", () => ({
      getDocument: jest
        .fn()
        .mockResolvedValue({ _id: "u1", roles: ["admin"], isActive: true }),
    }));
    return require("../middleware/system_auth.middleware").checkSystemApiAuth;
  }

  function reqWith({ query = {}, cookies = {}, headers = {} } = {}) {
    return { query, cookies, headers };
  }

  it("does not authenticate a session presented as ?token=", async () => {
    const checkSystemApiAuth = loadMiddleware();
    const req = reqWith({ query: { token: "GOOD" } });
    const next = jest.fn();
    await checkSystemApiAuth(req, {}, next);

    expect(next).toHaveBeenCalled();
    // Anonymous: the request proceeds, but with no sender attached, so every
    // downstream guard (systemApiAuth, adminAuth) rejects it.
    expect(req.sender).toBeFalsy();
    expect(req.byAdmin).toBeFalsy();
  });

  it("still authenticates the same token from the cookie", async () => {
    const checkSystemApiAuth = loadMiddleware();
    const { authCookieNames } = require("../constants");
    const req = reqWith({ cookies: { [authCookieNames.dbUser]: "GOOD" } });
    await checkSystemApiAuth(req, {}, jest.fn());
    expect(req.sender).toBeTruthy();
    expect(req.byAdmin).toBe(true);
  });

  it("still authenticates the same token from the Authorization header", async () => {
    const checkSystemApiAuth = loadMiddleware();
    const req = reqWith({ headers: { authorization: "Bearer GOOD" } });
    await checkSystemApiAuth(req, {}, jest.fn());
    expect(req.sender).toBeTruthy();
    expect(req.byAdmin).toBe(true);
  });
});

describe("#7 malformed ObjectIds are rejected", () => {
  const { isValidObjectId } = require("../utils/validators");

  it("accepts a real 24-hex id", () => {
    expect(isValidObjectId("507f1f77bcf86cd799439011")).toBe(true);
  });

  it.each([
    ["a short string", "abc"],
    ["an empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 12],
    // The one that matters: an object reaching a query builder is how operator
    // injection gets attempted, and it must never be mistaken for an id.
    ["an object", { $ne: null }],
  ])("rejects %s", (_label, value) => {
    expect(isValidObjectId(value)).toBe(false);
  });
});

describe("#6 the first-admin slot is claimed atomically", () => {
  const DUPLICATE_KEY = 11000;

  let insertOne;
  let deleteOne;

  beforeEach(() => {
    jest.resetModules();
    insertOne = jest.fn();
    deleteOne = jest.fn().mockResolvedValue({});
    jest.doMock("../core/client", () => ({
      getUserDB: jest.fn().mockResolvedValue({
        collection: () => ({ insertOne, deleteOne }),
      }),
    }));
  });

  it("returns true for the caller whose insert wins", async () => {
    insertOne.mockResolvedValue({ insertedId: "admin-bootstrap" });
    const { claimSetupSlot } = require("../utils/setup_lock");
    await expect(claimSetupSlot()).resolves.toBe(true);
  });

  it("returns false for a caller that loses on duplicate key", async () => {
    insertOne.mockRejectedValue({ code: DUPLICATE_KEY });
    const { claimSetupSlot } = require("../utils/setup_lock");
    await expect(claimSetupSlot()).resolves.toBe(false);
  });

  it("claims a FIXED _id, so concurrent callers collide by construction", async () => {
    insertOne.mockResolvedValue({});
    const { claimSetupSlot } = require("../utils/setup_lock");
    await claimSetupSlot();
    await claimSetupSlot();
    const [first] = insertOne.mock.calls[0];
    const [second] = insertOne.mock.calls[1];
    expect(first._id).toBe(second._id);
  });

  // A genuine database fault must not read as "someone else already claimed it"
  // — that would silently skip creating the admin.
  it("propagates a non-duplicate-key failure", async () => {
    insertOne.mockRejectedValue(Object.assign(new Error("no primary"), { code: 91 }));
    const { claimSetupSlot } = require("../utils/setup_lock");
    await expect(claimSetupSlot()).rejects.toThrow("no primary");
  });

  it("release deletes the same fixed id, so a failed attempt is retryable", async () => {
    const { releaseSetupSlot } = require("../utils/setup_lock");
    await releaseSetupSlot();
    expect(deleteOne).toHaveBeenCalledWith({ _id: "admin-bootstrap" });
  });

  it("never throws out of release — it runs on an already-failing path", async () => {
    deleteOne.mockRejectedValue(new Error("db down"));
    const { releaseSetupSlot } = require("../utils/setup_lock");
    await expect(releaseSetupSlot()).resolves.toBeUndefined();
  });
});

describe("#9 the public credential-bearing routes run the strict limiter", () => {
  // /verify and /reset-password carry tokens that verify an address or set a
  // password, but they are mounted at "/" rather than under the project auth
  // router, which is the only reason they sat on the 300/min global limiter
  // instead of the 30-per-15-min auth one.
  // express-rate-limit returns an anonymous function, so identity is the only
  // reliable check — and it is the stronger one anyway: it pins that these
  // routes run the SAME limiter as the rest of the auth surface, not merely
  // some limiter.
  const publicRoutes = require("../routes/public.routes");
  const { authLimiter } = require("../middleware/rate_limit.middleware");

  function handlersFor(method, path) {
    return publicRoutes.stack
      .filter((l) => l.route && l.route.path === path && l.route.methods[method])
      .flatMap((l) => l.route.stack.map((s) => s.handle));
  }

  it.each([
    ["get", "/verify"],
    ["get", "/reset-password"],
    ["post", "/reset-password"],
  ])("%s %s runs authLimiter", (method, path) => {
    expect(handlersFor(method, path)).toContain(authLimiter);
  });
});
