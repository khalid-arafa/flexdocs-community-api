// Two write-path failures that used to be reported to the caller as success:
//
//   1. createDocument swallowed a failed insert and returned null, so
//      POST /:col/add answered 200 {_id: null} AND emitted a realtime "add"
//      event for a document that was never stored. It now throws, and the
//      route maps the failure to a status (409 for a duplicate key, otherwise
//      500 through the central handler) without emitting anything.
//   2. DELETE /:col (admin, no filter) called dropCollection WITHOUT awaiting
//      it and answered 200 regardless, so a rejected drop became an unhandled
//      rejection while the caller was told the collection was gone.
//
// Real router + the real central error handler, only Mongo access mocked —
// mounting errorHandler is what pins that a 500 body carries no Mongo text.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");
jest.mock("../sockets/db.sockets", () => ({
  sendUpdateCollectionStreamEvent: jest.fn(),
  sendUpdateDocumentStreamEvent: jest.fn(),
}));

const request = require("supertest");
const express = require("express");

const {
  createDocument,
  getCollectionsList,
  deleteManyDocuments,
  dropCollection,
} = require("../core/db_service");
const { sendUpdateCollectionStreamEvent } = require("../sockets/db.sockets");
const { errorHandler } = require("../middleware/error_handler.middleware");

function createApp({
  isDbAdmin = false,
  dbRules = { "/items": { read: true, add: true, delete: true } },
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = { code: "test", userId: "owner-id", dbRules };
    req.isDbAdmin = isDbAdmin;
    next();
  });
  const dbRouter = require("../routes/db.routes");
  app.use("/projects/test/db", dbRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => jest.clearAllMocks());

describe("POST /:col/add fails loudly when the insert fails", () => {
  beforeEach(() => {
    getCollectionsList.mockResolvedValue({ collections: [], totalCount: 0 });
  });

  it("stores the document and reports its id on the happy path", async () => {
    createDocument.mockResolvedValue("inserted-id");
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items/add")
      .send({ title: "hello" });

    expect(res.status).toBe(200);
    expect(res.body._id).toBe("inserted-id");
    expect(sendUpdateCollectionStreamEvent).toHaveBeenCalled();
  });

  it("returns 500 — never 200 {_id: null} — when the insert throws", async () => {
    createDocument.mockRejectedValue(new Error("connection refused"));
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items/add")
      .send({ title: "hello" });

    expect(res.status).toBe(500);
    expect(res.body._id).toBeUndefined();
  });

  it("emits no realtime event for a document that was never stored", async () => {
    createDocument.mockRejectedValue(new Error("connection refused"));
    const app = createApp();

    await request(app).post("/projects/test/db/items/add").send({ title: "hello" });

    expect(sendUpdateCollectionStreamEvent).not.toHaveBeenCalled();
  });

  it("maps a duplicate key (11000) to 409 — a caller-chosen _id that already exists", async () => {
    createDocument.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }),
    );
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items/add")
      .send({ _id: { $oid: "507f1f77bcf86cd799439011" }, title: "hello" });

    expect(res.status).toBe(409);
    expect(sendUpdateCollectionStreamEvent).not.toHaveBeenCalled();
  });

  it("does not leak the Mongo error text on a 500", async () => {
    createDocument.mockRejectedValue(
      new Error("E11000 dup key: { : ObjectId('..') } ns: proj.items index: email_1"),
    );
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items/add")
      .send({ title: "hello" });

    expect(res.body.message).toBe("Internal server error");
    expect(res.body.message).not.toMatch(/ns:|index:/);
  });

  it("still accepts a caller-chosen _id via the $oid marker", async () => {
    createDocument.mockResolvedValue("507f1f77bcf86cd799439011");
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items/add")
      .send({ _id: { $oid: "507f1f77bcf86cd799439011" }, title: "hello" });

    expect(res.status).toBe(200);
    // The schema must hand the marker through untouched — coercing it is
    // db_service's job, and the seed scripts depend on choosing their own ids.
    expect(createDocument.mock.calls[0][0].data).toEqual({
      _id: { $oid: "507f1f77bcf86cd799439011" },
      title: "hello",
    });
  });

  it("rejects a non-object body before touching Mongo", async () => {
    const app = createApp();

    const res = await request(app)
      .post("/projects/test/db/items/add")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(["not", "a", "document"]));

    expect(res.status).toBe(400);
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("rejects an empty body before touching Mongo", async () => {
    const app = createApp();

    const res = await request(app).post("/projects/test/db/items/add").send({});

    expect(res.status).toBe(400);
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe("DELETE /:col awaits the admin collection drop", () => {
  beforeEach(() => {
    deleteManyDocuments.mockResolvedValue({ deletedCount: 3 });
  });

  it("reports success only after the drop resolves successfully", async () => {
    dropCollection.mockResolvedValue({ success: true });
    const app = createApp({ isDbAdmin: true });

    const res = await request(app).delete("/projects/test/db/items").send({});

    expect(res.status).toBe(200);
    expect(dropCollection).toHaveBeenCalledTimes(1);
    expect(sendUpdateCollectionStreamEvent).toHaveBeenCalled();
  });

  it("returns 500 and announces nothing when the drop fails", async () => {
    dropCollection.mockResolvedValue({ success: false, error: "not authorized on proj" });
    const app = createApp({ isDbAdmin: true });

    const res = await request(app).delete("/projects/test/db/items").send({});

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Internal server error");
    expect(sendUpdateCollectionStreamEvent).not.toHaveBeenCalled();
  });

  it("surfaces a rejected drop instead of leaving an unhandled rejection", async () => {
    dropCollection.mockRejectedValue(new Error("connection refused"));
    const app = createApp({ isDbAdmin: true });

    const res = await request(app).delete("/projects/test/db/items").send({});

    expect(res.status).toBe(500);
  });

  it("leaves the filtered (non-drop) path alone", async () => {
    const app = createApp({ isDbAdmin: true });

    const res = await request(app)
      .delete("/projects/test/db/items")
      .send({ filter: { archived: true } });

    expect(res.status).toBe(200);
    expect(dropCollection).not.toHaveBeenCalled();
  });
});
