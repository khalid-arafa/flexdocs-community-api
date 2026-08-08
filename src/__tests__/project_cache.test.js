// Coverage for the K4 per-request project document cache in
// project_auth.middleware.js: cache hits avoid a second Mongo round trip,
// invalidateProjectCache() busts stale reads right after a write, and a
// handler that mutates req.project in place can never corrupt what the next
// request reads back out of the cache.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");

const { getDocument } = require("../core/db_service");
const {
  projectApiAuth,
  invalidateProjectCache,
} = require("../middleware/project_auth.middleware");

function makeProject(overrides = {}) {
  return {
    code: "proj1",
    name: "Project One",
    isActive: true,
    isPublic: true,
    userId: "owner",
    credentials: [],
    ...overrides,
  };
}

function makeReq(overrides = {}) {
  return {
    params: { projectCode: "proj1" },
    path: "/some-route",
    headers: {},
    byAdmin: false,
    ...overrides,
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function runAuth(reqOverrides = {}) {
  const req = makeReq(reqOverrides);
  const res = makeRes();
  const next = jest.fn();
  await projectApiAuth(req, res, next);
  return { req, res, next };
}

describe("projectApiAuth project document cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateProjectCache("proj1");
  });

  it("only hits Mongo once across repeated requests for the same project code", async () => {
    getDocument.mockResolvedValue(makeProject());

    const first = await runAuth();
    const second = await runAuth();

    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(first.next).toHaveBeenCalled();
    expect(second.next).toHaveBeenCalled();
    expect(second.req.project.code).toBe("proj1");
  });

  it("re-fetches after invalidateProjectCache(code) — a stale read does not survive a write", async () => {
    getDocument.mockResolvedValueOnce(makeProject({ name: "Before Update" }));
    const before = await runAuth();
    expect(before.req.project.name).toBe("Before Update");
    expect(getDocument).toHaveBeenCalledTimes(1);

    // Simulate the write site calling invalidation right after the update.
    invalidateProjectCache("proj1");

    getDocument.mockResolvedValueOnce(makeProject({ name: "After Update" }));
    const after = await runAuth();
    expect(after.req.project.name).toBe("After Update");
    expect(getDocument).toHaveBeenCalledTimes(2);
  });

  it("does not let a downstream mutation of req.project leak into the next cached read", async () => {
    getDocument.mockResolvedValue(
      makeProject({ credentials: [{ name: "cred-a" }] }),
    );

    const first = await runAuth();
    // Simulate a handler mutating the object in place.
    first.req.project.name = "mutated-by-handler";
    first.req.project.credentials.push({ name: "cred-b" });

    const second = await runAuth();
    expect(second.req.project.name).toBe("Project One");
    expect(second.req.project.credentials).toEqual([{ name: "cred-a" }]);
    // Only the first request's own copy was touched.
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("falls back to Mongo again once the TTL backstop expires", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    getDocument.mockResolvedValue(makeProject());

    await runAuth();
    expect(getDocument).toHaveBeenCalledTimes(1);

    // Still within the 30s TTL — cache hit, no second fetch.
    nowSpy.mockReturnValue(1_000_000 + 10_000);
    await runAuth();
    expect(getDocument).toHaveBeenCalledTimes(1);

    // Past the 30s TTL — backstop kicks in even without explicit invalidation.
    nowSpy.mockReturnValue(1_000_000 + 31_000);
    await runAuth();
    expect(getDocument).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it("never caches a not-found lookup", async () => {
    getDocument.mockResolvedValue(null);

    const { res: firstRes } = await runAuth();
    expect(firstRes.status).toHaveBeenCalledWith(404);
    expect(getDocument).toHaveBeenCalledTimes(1);

    getDocument.mockResolvedValue(makeProject());
    const { req } = await runAuth();
    expect(req.project.code).toBe("proj1");
    expect(getDocument).toHaveBeenCalledTimes(2);
  });

  it("does not consult the cache at all for the synthetic _system/admin project", async () => {
    const { req } = await runAuth({
      params: { projectCode: "_system" },
      byAdmin: true,
    });
    expect(req.project.code).toBe("_system");
    expect(getDocument).not.toHaveBeenCalled();
  });
});
