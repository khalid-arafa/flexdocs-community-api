/**
 * Tests for the index-check cache.
 *
 * The cache key describes the *shape* of a request — which fields are filtered
 * and how the result is sorted — not the values being matched. Keying on values
 * made a lookup endpoint issue an index round-trip on essentially every request
 * while evicting its own entries, so these tests pin the shape/value split.
 */

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const ensureIndexes = require("../core/ensure_indexes");
const Logger = require("../utils/logger");

// Every real collection reports its _id index, so include it by default.
function fakeCollection(existing = [{ key: { _id: 1 } }]) {
  return {
    namespace: "proj1.posts",
    indexes: jest.fn().mockResolvedValue(existing),
    createIndex: jest.fn().mockResolvedValue("idx"),
  };
}

// The cache lives at module scope and outlives a single test.
beforeEach(() => ensureIndexes.clearIndexCache());

describe("cache key shape", () => {
  it("checks once for many values of the same field", async () => {
    const collection = fakeCollection();
    for (let i = 0; i < 50; i++) {
      await ensureIndexes({
        collection,
        query: { email: `user${i}@test.com` },
        canCreateIndexes: true,
      });
    }
    expect(collection.indexes).toHaveBeenCalledTimes(1);
    expect(collection.createIndex).toHaveBeenCalledTimes(1);
    expect(collection.createIndex).toHaveBeenCalledWith({ email: 1 });
  });

  it("treats a filter written in a different key order as the same shape", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, query: { a: 1, b: 2 }, canCreateIndexes: true });
    await ensureIndexes({ collection, query: { b: 2, a: 1 }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(1);
    expect(collection.createIndex).toHaveBeenCalledTimes(1);
  });

  it("checks again for a different set of filtered fields", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    await ensureIndexes({ collection, query: { status: "a" }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(2);
  });

  it("keeps the same field apart from a different sort direction", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, sort: { createdAt: 1 }, canCreateIndexes: true });
    await ensureIndexes({ collection, sort: { createdAt: -1 }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(2);
  });

  // Sort key order is semantically significant, unlike filter key order.
  it("keeps two sort orders of the same fields apart", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, sort: { a: 1, b: 1 }, canCreateIndexes: true });
    await ensureIndexes({ collection, sort: { b: 1, a: 1 }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(2);
  });

  it("scopes the cache per collection", async () => {
    const posts = fakeCollection();
    const comments = fakeCollection();
    comments.namespace = "proj1.comments";
    await ensureIndexes({ collection: posts, query: { email: "a" }, canCreateIndexes: true });
    await ensureIndexes({ collection: comments, query: { email: "a" }, canCreateIndexes: true });
    expect(comments.indexes).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest entry once the cache is full", async () => {
    const collection = fakeCollection();
    const INDEX_CACHE_MAX = 5000;
    for (let i = 0; i < INDEX_CACHE_MAX; i++) {
      await ensureIndexes({ collection, query: { [`f${i}`]: 1 }, canCreateIndexes: true });
    }
    collection.indexes.mockClear();
    // Pushes the cache past capacity, dropping the f0 entry...
    await ensureIndexes({ collection, query: { overflow: 1 }, canCreateIndexes: true });
    // ...so the shape checked first is checked again.
    await ensureIndexes({ collection, query: { f0: 2 }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(2);
  });
});

describe("index selection", () => {
  it("does nothing when the caller may not create indexes", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, query: { email: "a" } });
    expect(collection.indexes).not.toHaveBeenCalled();
  });

  it("ignores _id, which is always indexed", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, query: { _id: "abc" }, canCreateIndexes: true });
    expect(collection.createIndex).not.toHaveBeenCalled();
  });

  it("creates a compound index when filter and sort differ", async () => {
    const collection = fakeCollection();
    await ensureIndexes({
      collection,
      query: { status: "published" },
      sort: { createdAt: -1 },
      canCreateIndexes: true,
    });
    expect(collection.createIndex).toHaveBeenCalledWith({ status: 1, createdAt: -1 });
  });

  it("creates a single directed index when filter and sort are the same field", async () => {
    const collection = fakeCollection();
    await ensureIndexes({
      collection,
      query: { createdAt: { $gt: 1 } },
      sort: { createdAt: -1 },
      canCreateIndexes: true,
    });
    expect(collection.createIndex).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it("indexes the sort field when there is no filter", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, sort: { createdAt: -1 }, canCreateIndexes: true });
    expect(collection.createIndex).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it("creates nothing for an unfiltered, unsorted read", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, canCreateIndexes: true });
    expect(collection.createIndex).not.toHaveBeenCalled();
  });

  it("skips creation when an identical index exists", async () => {
    const collection = fakeCollection([{ key: { _id: 1 } }, { key: { email: 1 } }]);
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    expect(collection.createIndex).not.toHaveBeenCalled();
  });

  it("skips creation when the wanted index is a prefix of an existing one", async () => {
    const collection = fakeCollection([{ key: { status: 1, createdAt: -1, author: 1 } }]);
    await ensureIndexes({
      collection,
      query: { status: "published" },
      sort: { createdAt: -1 },
      canCreateIndexes: true,
    });
    expect(collection.createIndex).not.toHaveBeenCalled();
  });

  it("ignores direction of an existing single-field index for an equality filter", async () => {
    const collection = fakeCollection([{ key: { email: -1 } }]);
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    expect(collection.createIndex).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("stays silent and uncached when the collection does not exist yet", async () => {
    const collection = fakeCollection();
    const missing = new Error("ns not found");
    missing.codeName = "NamespaceNotFound";
    collection.indexes.mockRejectedValue(missing);

    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });

    expect(collection.indexes).toHaveBeenCalledTimes(2);
    expect(Logger.error).not.toHaveBeenCalled();
  });

  it("logs rather than throws when index creation fails", async () => {
    const collection = fakeCollection();
    collection.createIndex.mockRejectedValue(new Error("not authorized"));
    await expect(
      ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true }),
    ).resolves.toBeUndefined();
    expect(Logger.error).toHaveBeenCalled();
  });
});

describe("removeFromIndexCache", () => {
  it("forces the next call on that shape to re-check", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    ensureIndexes.removeFromIndexCache(collection, { email: "a" });
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(2);
  });

  it("accepts the filter in any key order", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, query: { a: 1, b: 2 }, canCreateIndexes: true });
    ensureIndexes.removeFromIndexCache(collection, { b: 9, a: 9 });
    await ensureIndexes({ collection, query: { a: 1, b: 2 }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(2);
  });

  it("leaves other shapes cached", async () => {
    const collection = fakeCollection();
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    ensureIndexes.removeFromIndexCache(collection, { status: "a" });
    await ensureIndexes({ collection, query: { email: "a" }, canCreateIndexes: true });
    expect(collection.indexes).toHaveBeenCalledTimes(1);
  });
});
