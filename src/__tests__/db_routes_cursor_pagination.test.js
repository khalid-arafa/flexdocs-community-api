// C11: POST /:col gained opt-in keyset ("cursor") pagination alongside the
// existing page/skip offset path, which must stay byte-identical for every
// caller that doesn't send `cursor`/`paginate: "cursor"`. Real router, only
// Mongo access mocked.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");

const request = require("supertest");
const express = require("express");
const { ObjectId } = require("mongodb");

const { getManyDocuments, countDocuments } = require("../core/db_service");

function createApp({ isDbAdmin = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = { code: "test", userId: "owner-id", dbRules: { "/items": { read: true } } };
    req.isDbAdmin = isDbAdmin;
    next();
  });
  const dbRouter = require("../routes/db.routes");
  app.use("/projects/test/db", dbRouter);
  return app;
}

afterEach(() => jest.clearAllMocks());

describe("POST /:col — offset pagination stays unchanged when cursor is not sent", () => {
  it("still returns a bare array for a non-admin caller", async () => {
    getManyDocuments.mockResolvedValue([{ _id: "1" }, { _id: "2" }]);
    const app = createApp();

    const res = await request(app).post("/projects/test/db/items").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ _id: "1" }, { _id: "2" }]);
    expect(getManyDocuments.mock.calls[0][0].skip).toBe(0);
  });

  it("still returns the existing object shape (no nextCursor added) for an admin caller in offset mode", async () => {
    getManyDocuments.mockResolvedValue([{ _id: "1" }]);
    countDocuments.mockResolvedValue(1);
    const app = createApp({ isDbAdmin: true });

    const res = await request(app).post("/projects/test/db/items").send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ docs: [{ _id: "1" }], totalCount: 1, page: 1, ipp: 100 });
    expect(res.body.nextCursor).toBeNull();
  });
});

describe("POST /:col — cursor mode", () => {
  it("returns { docs, nextCursor } instead of a bare array once cursor mode is requested", async () => {
    const docs = Array.from({ length: 3 }, () => ({ _id: new ObjectId().toString() }));
    getManyDocuments.mockResolvedValue(docs);
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items")
      .send({ paginate: "cursor", limit: 3 });

    expect(res.status).toBe(200);
    expect(res.body.docs).toHaveLength(3);
    expect(typeof res.body.nextCursor).toBe("string");
  });

  it("returns nextCursor: null when the page comes back short (no more results)", async () => {
    getManyDocuments.mockResolvedValue([{ _id: new ObjectId().toString() }]);
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items")
      .send({ paginate: "cursor", limit: 10 });

    expect(res.body.nextCursor).toBeNull();
  });

  it("forwards the decoded seek condition to getManyDocuments and resets skip to 0", async () => {
    const priorId = new ObjectId().toString();
    const cursorStr = Buffer.from(JSON.stringify({ id: priorId }), "utf8").toString("base64url");
    getManyDocuments.mockResolvedValue([]);
    const app = createApp();

    await request(app)
      .post("/projects/test/db/items")
      .send({ cursor: cursorStr, skip: 40 });

    const call = getManyDocuments.mock.calls[0][0];
    expect(call.skip).toBe(0);
    expect(call.query).toEqual({ _id: { $gt: { $oid: priorId } } });
    expect(call.sort).toEqual({ _id: 1 });
  });

  it("rejects a malformed cursor with 400 instead of querying Mongo", async () => {
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items")
      .send({ cursor: "not-a-valid-cursor" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid cursor");
    expect(getManyDocuments).not.toHaveBeenCalled();
  });

  it("includes nextCursor in the admin object response too", async () => {
    const docs = Array.from({ length: 2 }, () => ({ _id: new ObjectId().toString() }));
    getManyDocuments.mockResolvedValue(docs);
    countDocuments.mockResolvedValue(50);
    const app = createApp({ isDbAdmin: true });

    const res = await request(app)
      .post("/projects/test/db/items")
      .send({ paginate: "cursor", limit: 2 });

    expect(res.status).toBe(201);
    expect(typeof res.body.nextCursor).toBe("string");
  });
});
