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
    createIndex: jest.fn().mockResolvedValue({}),
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

    // createDocument — error swallowed, returns null
    it("createDocument with $where in document data should return null (not store)", async () => {
      const result = await createDocument({
        ...BASE,
        data: { $where: "1==1", name: "test" },
      });
      expect(result).toBeNull();
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
  });
});
