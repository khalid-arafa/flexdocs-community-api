jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock("../core/client");
jest.mock("../core/ensure_indexes", () => jest.fn().mockResolvedValue(undefined));

const { getUserDB } = require("../core/client");
const {
  getManyDocuments,
  getDocument,
  createDocument,
  updateDocument,
  updateManyDocuments,
  deleteDocument,
  deleteManyDocuments,
  listIndexes,
  createIndex,
  dropIndex,
} = require("../core/db_service");

// ─── mock db factory ─────────────────────────────────────────────────────────

function makeFindChain(docs = []) {
  const chain = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    project: jest.fn(),
    maxTimeMS: jest.fn(),
    toArray: jest.fn().mockResolvedValue(docs),
  };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.project.mockReturnValue(chain);
  chain.maxTimeMS.mockReturnValue(chain);
  return chain;
}

function makeMockDb({ docs = [], foundDoc = null, insertedId = "new-id" } = {}) {
  const collection = {
    find: jest.fn().mockReturnValue(makeFindChain(docs)),
    findOne: jest.fn().mockResolvedValue(foundDoc),
    insertOne: jest.fn().mockResolvedValue({ insertedId }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
    indexes: jest.fn().mockResolvedValue([]),
    createIndex: jest.fn().mockResolvedValue("field_1"),
    dropIndex: jest.fn().mockResolvedValue({}),
  };
  const db = {
    collection: jest.fn().mockReturnValue(collection),
    createCollection: jest.fn().mockResolvedValue(collection),
    listCollections: jest.fn().mockReturnValue({
      hasNext: jest.fn().mockResolvedValue(true),
      toArray: jest.fn().mockResolvedValue([]),
    }),
  };
  return { db, collection };
}

const BASE = { userId: "u1", projectCode: "testproj", collectionName: "posts" };

// ─── tests ───────────────────────────────────────────────────────────────────

describe("db_service.js", () => {
  beforeEach(() => {
    const { db } = makeMockDb();
    getUserDB.mockResolvedValue(db);
  });

  afterEach(() => jest.clearAllMocks());

  // ── NoSQL injection prevention ────────────────────────────────────────────

  describe("NoSQL injection prevention (formatQueryObj)", () => {
    // $where
    it("should throw on top-level $where in a query", async () => {
      await expect(
        getManyDocuments({ ...BASE, query: { $where: "function() { return true; }" } })
      ).rejects.toThrow("Forbidden operator: $where");
    });

    it("should throw on nested $where inside an operator object", async () => {
      await expect(
        getManyDocuments({ ...BASE, query: { status: { $where: "1==1" } } })
      ).rejects.toThrow("Forbidden operator: $where");
    });

    it("should throw on $where inside a $or array element", async () => {
      await expect(
        getManyDocuments({
          ...BASE,
          query: { $or: [{ age: { $gt: 5 } }, { $where: "sleep(200)" }] },
        })
      ).rejects.toThrow("Forbidden operator: $where");
    });

    // $function
    it("should throw on $function operator", async () => {
      await expect(
        getManyDocuments({
          ...BASE,
          query: { $function: { body: "function() { return true; }", args: [], lang: "js" } },
        })
      ).rejects.toThrow("Forbidden operator: $function");
    });

    // $accumulator
    it("should throw on $accumulator operator", async () => {
      await expect(
        getManyDocuments({
          ...BASE,
          query: { $accumulator: { init: "function() {}", accumulate: "function() {}", merge: "function() {}", lang: "js" } },
        })
      ).rejects.toThrow("Forbidden operator: $accumulator");
    });

    // getDocument — error swallowed, returns null
    it("getDocument with $where in query should return null (not execute the query)", async () => {
      const result = await getDocument({
        ...BASE,
        query: { $where: "1==1" },
      });
      expect(result).toBeNull();
    });

    // createDocument — throws (the internal try/catch that swallowed this and
    // returned null is gone: a caller that is told `null` cannot tell a
    // refused write from a stored one, so /add answered 200 {_id: null} and
    // emitted a realtime "add" for a document that never existed).
    it("createDocument with $where in document data should throw (and not store)", async () => {
      const { db, collection } = makeMockDb();
      getUserDB.mockResolvedValue(db);

      await expect(
        createDocument({ ...BASE, data: { $where: "1==1", name: "test" } }),
      ).rejects.toThrow("Forbidden operator: $where");
      expect(collection.insertOne).not.toHaveBeenCalled();
    });

    // updateDocument — throws (no internal try-catch)
    it("updateDocument with $where in filter should throw", async () => {
      await expect(
        updateDocument({
          ...BASE,
          query: { $where: "1==1" },
          updateData: { name: "x" },
        })
      ).rejects.toThrow("Forbidden operator: $where");
    });

    it("updateDocument with $where in updateData should throw", async () => {
      await expect(
        updateDocument({
          ...BASE,
          query: { _id: "some-id" },
          updateData: { $where: "1==1" },
        })
      ).rejects.toThrow("Forbidden operator: $where");
    });

    // updateManyDocuments — throws
    it("updateManyDocuments with $where in filter should throw", async () => {
      await expect(
        updateManyDocuments("u1", "testproj", "posts", { $where: "1==1" }, { name: "x" })
      ).rejects.toThrow("Forbidden operator: $where");
    });

    // deleteDocument — throws
    it("deleteDocument with $where in query should throw", async () => {
      await expect(
        deleteDocument({ ...BASE, query: { $where: "1==1" } })
      ).rejects.toThrow("Forbidden operator: $where");
    });

    // deleteManyDocuments — throws
    it("deleteManyDocuments with $where in query should throw", async () => {
      await expect(
        deleteManyDocuments({ ...BASE, query: { $where: "1==1" } })
      ).rejects.toThrow("Forbidden operator: $where");
    });
  });

  // ── formatQueryObj — legitimate operators still work ─────────────────────

  describe("formatQueryObj — legitimate operators and type conversions", () => {
    it("should allow $gt, $lt, $gte, $lte in queries", async () => {
      const { db, collection } = makeMockDb({ docs: [{ age: 25 }] });
      getUserDB.mockResolvedValue(db);
      const result = await getManyDocuments({
        ...BASE,
        query: { age: { $gt: 18, $lt: 65 } },
      });
      expect(collection.find).toHaveBeenCalled();
      expect(result).toEqual([{ age: 25 }]);
    });

    it("should allow $or operator in queries", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      await getManyDocuments({
        ...BASE,
        query: { $or: [{ status: "active" }, { role: "admin" }] },
      });
      expect(collection.find).toHaveBeenCalled();
    });

    it("should allow $regex operator in queries", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      await getManyDocuments({
        ...BASE,
        query: { name: { $regex: "^test", $options: "i" } },
      });
      expect(collection.find).toHaveBeenCalled();
    });

    it("should allow $in and $nin operators in queries", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      await getManyDocuments({
        ...BASE,
        query: { status: { $in: ["active", "pending"] } },
      });
      expect(collection.find).toHaveBeenCalled();
    });

    it("should convert $oid string to ObjectId", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      const oidStr = "507f1f77bcf86cd799439011";
      await getManyDocuments({
        ...BASE,
        query: { userId: { $oid: oidStr } },
      });
      const passedQuery = collection.find.mock.calls[0][0];
      expect(passedQuery.userId).toBeInstanceOf(require("mongodb").ObjectId);
      expect(passedQuery.userId.toString()).toBe(oidStr);
    });

    it("should convert $date string to a Date object", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      await getManyDocuments({
        ...BASE,
        query: { createdAt: { $date: "2024-01-01T00:00:00.000Z" } },
      });
      const passedQuery = collection.find.mock.calls[0][0];
      expect(passedQuery.createdAt).toBeInstanceOf(Date);
    });

    it("should convert _id string to ObjectId when it is a valid ObjectId", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      const id = "507f1f77bcf86cd799439011";
      await getManyDocuments({ ...BASE, query: { _id: id } });
      const passedQuery = collection.find.mock.calls[0][0];
      expect(passedQuery._id).toBeInstanceOf(require("mongodb").ObjectId);
    });

    // C9: _id previously only coerced when it was the query's sole key and a
    // bare string. Sibling keys and $in/$nin arrays fell through unconverted,
    // so a filter like { _id: { $in: [...] } } silently matched nothing —
    // MongoDB never matches a string against a stored ObjectId.

    it("should convert _id to ObjectId when other keys are present in the same filter", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      const id = "507f1f77bcf86cd799439011";
      await getManyDocuments({ ...BASE, query: { _id: id, ownerId: "owner-1" } });
      const passedQuery = collection.find.mock.calls[0][0];
      expect(passedQuery._id).toBeInstanceOf(require("mongodb").ObjectId);
      expect(passedQuery._id.toString()).toBe(id);
      expect(passedQuery.ownerId).toBe("owner-1");
    });

    it("should convert every valid ObjectId string inside _id.$in", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      const idA = "507f1f77bcf86cd799439011";
      const idB = "507f1f77bcf86cd799439012";
      await getManyDocuments({ ...BASE, query: { _id: { $in: [idA, idB] } } });
      const passedQuery = collection.find.mock.calls[0][0];
      expect(passedQuery._id.$in).toHaveLength(2);
      for (const item of passedQuery._id.$in) {
        expect(item).toBeInstanceOf(require("mongodb").ObjectId);
      }
      expect(passedQuery._id.$in.map(String)).toEqual([idA, idB]);
    });

    it("should convert valid ObjectId strings inside _id.$nin and leave an invalid one untouched", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      const idA = "507f1f77bcf86cd799439011";
      await getManyDocuments({ ...BASE, query: { _id: { $nin: [idA, "not-an-object-id"] } } });
      const passedQuery = collection.find.mock.calls[0][0];
      expect(passedQuery._id.$nin[0]).toBeInstanceOf(require("mongodb").ObjectId);
      expect(passedQuery._id.$nin[1]).toBe("not-an-object-id");
    });

    it("should still coerce a single-key _id: { $oid } wrapper the same as before", async () => {
      const { db, collection } = makeMockDb({ docs: [] });
      getUserDB.mockResolvedValue(db);
      const id = "507f1f77bcf86cd799439011";
      await getManyDocuments({ ...BASE, query: { _id: { $oid: id } } });
      const passedQuery = collection.find.mock.calls[0][0];
      expect(passedQuery._id).toBeInstanceOf(require("mongodb").ObjectId);
      expect(passedQuery._id.toString()).toBe(id);
    });
  });

  // ── C15: admin index management ───────────────────────────────────────────

  describe("listIndexes / createIndex / dropIndex", () => {
    it("listIndexes returns the collection's indexes", async () => {
      const { db, collection } = makeMockDb();
      collection.indexes.mockResolvedValue([{ key: { _id: 1 }, name: "_id_" }]);
      getUserDB.mockResolvedValue(db);
      const result = await listIndexes({ ...BASE });
      expect(result).toEqual({ success: true, indexes: [{ key: { _id: 1 }, name: "_id_" }] });
    });

    it("listIndexes reports failure without throwing", async () => {
      const { db, collection } = makeMockDb();
      collection.indexes.mockRejectedValue(new Error("boom"));
      getUserDB.mockResolvedValue(db);
      const result = await listIndexes({ ...BASE });
      expect(result).toEqual({ success: false, error: "boom" });
    });

    it("createIndex creates the requested keys and returns its name", async () => {
      const { db, collection } = makeMockDb();
      getUserDB.mockResolvedValue(db);
      const result = await createIndex({ ...BASE, keys: { email: 1 }, options: { unique: true } });
      expect(collection.createIndex).toHaveBeenCalledWith({ email: 1 }, { unique: true });
      expect(result).toEqual({ success: true, name: "field_1" });
    });

    it("createIndex reports failure without throwing", async () => {
      const { db, collection } = makeMockDb();
      collection.createIndex.mockRejectedValue(new Error("index build failed"));
      getUserDB.mockResolvedValue(db);
      const result = await createIndex({ ...BASE, keys: { email: 1 } });
      expect(result).toEqual({ success: false, error: "index build failed" });
    });

    it("dropIndex drops the named index", async () => {
      const { db, collection } = makeMockDb();
      getUserDB.mockResolvedValue(db);
      const result = await dropIndex({ ...BASE, name: "email_1" });
      expect(collection.dropIndex).toHaveBeenCalledWith("email_1");
      expect(result).toEqual({ success: true });
    });

    it("dropIndex refuses to drop the default _id_ index", async () => {
      const { db, collection } = makeMockDb();
      getUserDB.mockResolvedValue(db);
      const result = await dropIndex({ ...BASE, name: "_id_" });
      expect(collection.dropIndex).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it("dropIndex reports failure without throwing", async () => {
      const { db, collection } = makeMockDb();
      collection.dropIndex.mockRejectedValue(new Error("index not found"));
      getUserDB.mockResolvedValue(db);
      const result = await dropIndex({ ...BASE, name: "ghost_1" });
      expect(result).toEqual({ success: false, error: "index not found" });
    });
  });
});
