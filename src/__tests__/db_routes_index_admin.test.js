// C15: admin index-management endpoints (GET/POST/DELETE /:col/indexes),
// additive alongside ensure_indexes.js's automatic indexing (stays
// default-on). Real router, only Mongo access mocked.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");

const request = require("supertest");
const express = require("express");

const { listIndexes, createIndex, dropIndex, getManyDocuments, countDocuments } = require("../core/db_service");

function createApp({ isDbAdmin = false, manualIndexes } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = {
      code: "test",
      userId: "owner-id",
      dbRules: { "/items": { read: true } },
      manualIndexes,
    };
    req.isDbAdmin = isDbAdmin;
    next();
  });
  const dbRouter = require("../routes/db.routes");
  app.use("/projects/test/db", dbRouter);
  return app;
}

afterEach(() => jest.clearAllMocks());

describe("GET /:col/indexes", () => {
  it("denies a non-admin caller", async () => {
    const app = createApp({ isDbAdmin: false });
    const res = await request(app).get("/projects/test/db/items/indexes");
    expect(res.status).toBe(403);
    expect(listIndexes).not.toHaveBeenCalled();
  });

  it("returns the collection's indexes for an admin caller", async () => {
    listIndexes.mockResolvedValue({ success: true, indexes: [{ key: { _id: 1 }, name: "_id_" }] });
    const app = createApp({ isDbAdmin: true });
    const res = await request(app).get("/projects/test/db/items/indexes");
    expect(res.status).toBe(200);
    expect(res.body.indexes).toEqual([{ key: { _id: 1 }, name: "_id_" }]);
  });

  it("returns 500 when listIndexes fails", async () => {
    listIndexes.mockResolvedValue({ success: false, error: "boom" });
    const app = createApp({ isDbAdmin: true });
    const res = await request(app).get("/projects/test/db/items/indexes");
    expect(res.status).toBe(500);
  });
});

describe("POST /:col/indexes", () => {
  it("denies a non-admin caller", async () => {
    const app = createApp({ isDbAdmin: false });
    const res = await request(app)
      .post("/projects/test/db/items/indexes")
      .send({ keys: { email: 1 } });
    expect(res.status).toBe(403);
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("creates an index for an admin caller", async () => {
    createIndex.mockResolvedValue({ success: true, name: "email_1" });
    const app = createApp({ isDbAdmin: true });
    const res = await request(app)
      .post("/projects/test/db/items/indexes")
      .send({ keys: { email: 1 }, options: { unique: true } });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("email_1");
    expect(createIndex.mock.calls[0][0]).toMatchObject({
      collectionName: "items",
      keys: { email: 1 },
      options: { unique: true },
    });
  });

  it("rejects an empty keys object with a 400 before ever calling createIndex", async () => {
    const app = createApp({ isDbAdmin: true });
    const res = await request(app)
      .post("/projects/test/db/items/indexes")
      .send({ keys: {} });
    expect(res.status).toBe(400);
    expect(createIndex).not.toHaveBeenCalled();
  });
});

describe("DELETE /:col/indexes/:name", () => {
  it("denies a non-admin caller", async () => {
    const app = createApp({ isDbAdmin: false });
    const res = await request(app).delete("/projects/test/db/items/indexes/email_1");
    expect(res.status).toBe(403);
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it("drops the named index for an admin caller", async () => {
    dropIndex.mockResolvedValue({ success: true });
    const app = createApp({ isDbAdmin: true });
    const res = await request(app).delete("/projects/test/db/items/indexes/email_1");
    expect(res.status).toBe(200);
    expect(dropIndex.mock.calls[0][0]).toMatchObject({ collectionName: "items", name: "email_1" });
  });

  it("returns 400 when the service refuses (e.g. the default _id_ index)", async () => {
    dropIndex.mockResolvedValue({ success: false, error: "Cannot drop the default _id_ index" });
    const app = createApp({ isDbAdmin: true });
    const res = await request(app).delete("/projects/test/db/items/indexes/_id_");
    expect(res.status).toBe(400);
  });
});

describe("project.manualIndexes threads through to POST /:col", () => {
  it("passes canCreateIndexes: true by default (manualIndexes unset)", async () => {
    getManyDocuments.mockResolvedValue([]);
    const app = createApp({ isDbAdmin: false, manualIndexes: undefined });
    await request(app).post("/projects/test/db/items").send({});
    expect(getManyDocuments.mock.calls[0][0].canCreateIndexes).toBe(true);
  });

  it("passes canCreateIndexes: false once a project opts into manualIndexes", async () => {
    getManyDocuments.mockResolvedValue([]);
    const app = createApp({ isDbAdmin: false, manualIndexes: true });
    await request(app).post("/projects/test/db/items").send({});
    expect(getManyDocuments.mock.calls[0][0].canCreateIndexes).toBe(false);
  });

  it("also threads through to countDocuments for an admin caller", async () => {
    getManyDocuments.mockResolvedValue([]);
    countDocuments.mockResolvedValue(0);
    const app = createApp({ isDbAdmin: true, manualIndexes: true });
    await request(app).post("/projects/test/db/items").send({});
    expect(countDocuments.mock.calls[0][0].canCreateIndexes).toBe(false);
  });
});
