/**
 * Boot-path reliability.
 *
 * Two things are covered here, both of which used to be duplicated or absent:
 *
 *   connectWithRetry  — the boot connect policy. A Mongo that is still coming
 *                       up must be waited out; a Mongo that never comes up must
 *                       REJECT, because index.js turns that rejection into a
 *                       non-zero exit. The old code had no .catch at all, so an
 *                       unreachable Mongo left the process alive and not
 *                       listening, which no supervisor can detect.
 *   ProjectDocCache   — the one cache now shared by projectApiAuth and the
 *                       change-stream driver. Its interesting behavior is
 *                       staleness: a project document carries rules and
 *                       credentials, so "cached one moment too long" is a
 *                       security bug, not a freshness one.
 *
 * The real boot sequence (index.js) is not exercised: requiring it binds a port
 * and opens sockets. What it does with the outcome is one .then/.catch over the
 * function tested here.
 */

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));

const mockConnect = jest.fn();
jest.mock("mongodb", () => ({
  MongoClient: function MongoClient() {
    return { connect: mockConnect, db: jest.fn(), close: jest.fn(), watch: jest.fn() };
  },
}));

const { ProjectDocCache } = require("../core/project_doc_cache");

// A fresh module registry per call, because connectToMongo caches its connect
// promise for the lifetime of the module.
function loadClient() {
  let mod;
  jest.isolateModules(() => {
    mod = require("../core/client");
  });
  return mod;
}

// Fast enough to keep the suite quick, still a real backoff loop on real timers.
const FAST = { baseDelayMs: 1, maxDelayMs: 2 };

describe("connectWithRetry", () => {
  it("rides out a Mongo that is not up yet and resolves once it is", async () => {
    mockConnect
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValue(undefined);

    const { connectWithRetry } = loadClient();
    await connectWithRetry({ budgetMs: 5000, ...FAST });

    expect(mockConnect).toHaveBeenCalledTimes(3);
  });

  it("rejects once the budget is spent instead of retrying forever", async () => {
    mockConnect.mockRejectedValue(new Error("no route to host"));

    const { connectWithRetry } = loadClient();
    await expect(
      connectWithRetry({ budgetMs: 30, ...FAST }),
    ).rejects.toThrow("no route to host");

    // It is the rejection that makes index.js exit non-zero; a resolve or a
    // hang here is the zombie this whole change exists to remove.
    expect(mockConnect.mock.calls.length).toBeGreaterThan(1);
  });

  it("always makes at least one full attempt, however small the budget", async () => {
    mockConnect.mockRejectedValue(new Error("down"));

    const { connectWithRetry } = loadClient();
    await expect(connectWithRetry({ budgetMs: 0, ...FAST })).rejects.toThrow("down");

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("shares one connection with the request path — a later caller does not reconnect", async () => {
    mockConnect.mockResolvedValue(undefined);

    const { connectWithRetry, connectToMongo } = loadClient();
    await connectWithRetry({ budgetMs: 5000, ...FAST });
    await connectToMongo();
    await connectToMongo();

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectDocCache", () => {
  const doc = (overrides = {}) => ({ code: "proj1", credentials: [], ...overrides });

  it("serves a hit within the TTL and re-reads once the backstop lapses", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    const cache = new ProjectDocCache({ ttlMs: 30_000 });
    const fetch = jest.fn().mockResolvedValue(doc());

    await cache.getOrFetch("proj1", fetch);
    now.mockReturnValue(1_000_000 + 29_000);
    await cache.getOrFetch("proj1", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 31_000);
    await cache.getOrFetch("proj1", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("re-reads after invalidate, so a write is visible on the very next lookup", async () => {
    const cache = new ProjectDocCache();
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(doc({ name: "before" }))
      .mockResolvedValueOnce(doc({ name: "after" }));

    expect((await cache.getOrFetch("proj1", fetch)).name).toBe("before");
    cache.invalidate("proj1");
    expect((await cache.getOrFetch("proj1", fetch)).name).toBe("after");
  });

  it("never memoises a miss by default, but does when cacheMisses is on", async () => {
    const strict = new ProjectDocCache({ cacheMisses: false });
    const strictFetch = jest.fn().mockResolvedValue(null);
    await strict.getOrFetch("gone", strictFetch);
    await strict.getOrFetch("gone", strictFetch);
    expect(strictFetch).toHaveBeenCalledTimes(2);

    const lenient = new ProjectDocCache({ cacheMisses: true });
    const lenientFetch = jest.fn().mockResolvedValue(null);
    expect(await lenient.getOrFetch("not-a-project", lenientFetch)).toBeNull();
    await lenient.getOrFetch("not-a-project", lenientFetch);
    expect(lenientFetch).toHaveBeenCalledTimes(1);
  });

  it("does not cache a read that was in flight when an invalidation landed", async () => {
    const cache = new ProjectDocCache();
    let release;
    const stale = new Promise((resolve) => { release = resolve; });

    const pending = cache.getOrFetch("proj1", () => stale);
    cache.invalidate("proj1"); // a credential rotation commits mid-flight
    release(doc({ name: "pre-rotation" }));

    // The in-flight reader still gets what it read...
    expect((await pending).name).toBe("pre-rotation");
    // ...but it must not have become the answer everyone else gets.
    const fresh = jest.fn().mockResolvedValue(doc({ name: "post-rotation" }));
    expect((await cache.getOrFetch("proj1", fresh)).name).toBe("post-rotation");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("keeps that guard intact even after the invalidation stamps are pruned", async () => {
    // The stamp map is bounded too, so a busy deployment evicts stamps while a
    // read is in flight. A monotonic counter makes that safe: the worst case is
    // a needless re-fetch, never a stale document promoted into the cache.
    const cache = new ProjectDocCache({ maxEntries: 4 });
    let release;
    const pending = cache.getOrFetch("proj1", () => new Promise((r) => { release = r; }));

    cache.invalidate("proj1");
    for (let i = 0; i < 10; i++) cache.invalidate(`other-${i}`); // prunes proj1's stamp
    release(doc({ name: "pre-write" }));
    await pending;

    const fresh = jest.fn().mockResolvedValue(doc({ name: "post-write" }));
    expect((await cache.getOrFetch("proj1", fresh)).name).toBe("post-write");
  });

  it("hands out clones, so a caller mutating its copy cannot corrupt the entry", async () => {
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const cache = new ProjectDocCache({ clone });
    const fetch = jest.fn().mockResolvedValue(doc({ credentials: [{ name: "cred-a" }] }));

    const first = await cache.getOrFetch("proj1", fetch);
    first.credentials.push({ name: "injected" });
    first.code = "mutated";

    const second = await cache.getOrFetch("proj1", fetch);
    expect(second.code).toBe("proj1");
    expect(second.credentials).toEqual([{ name: "cred-a" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stays bounded when the key space is unbounded", async () => {
    const cache = new ProjectDocCache({ maxEntries: 5, cacheMisses: true });
    for (let i = 0; i < 200; i++) {
      await cache.getOrFetch(`db-${i}`, async () => null);
    }
    expect(cache.size).toBe(5);
  });
});
