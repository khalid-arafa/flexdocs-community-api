// K5: GET/DELETE /:col/:id used to fetch the target document twice — once in
// documentMiddleware (to feed the rules check) and again, independently, in
// the route handler, with the identical {_id} query. documentMiddleware now
// stashes its fetch on req.document and the handlers reuse it. These tests
// pin the dedup at the route level (real documentMiddleware + real router,
// only Mongo access mocked), covering both the non-admin path (fetch reused)
// and the req.isDbAdmin path (documentMiddleware's fetch never ran, so the
// handler's own fallback fetch is expected, and still only runs once).

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

const { getDocument, deleteDocument, getCollectionsList } = require("../core/db_service");

const VALID_ID = "507f1f77bcf86cd799439011";

function createApp({ isDbAdmin = false, dbRules = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = { code: "test", userId: "owner-id", dbRules };
    req.isDbAdmin = isDbAdmin;
    next();
  });
  // Required fresh per app so the real router (and the real documentMiddleware
  // it wires up) runs against the mocks configured above.
  const dbRouter = require("../routes/db.routes");
  app.use("/projects/test/db", dbRouter);
  return app;
}

afterEach(() => jest.clearAllMocks());

describe("GET /:col/:id document fetch dedup", () => {
  it("calls getDocument exactly once for a non-admin request (reuses documentMiddleware's fetch)", async () => {
    getDocument.mockResolvedValue({ _id: VALID_ID, ownerId: "owner-id" });
    const app = createApp({ dbRules: { "/posts": { read: true } } });

    const res = await request(app).get(`/projects/test/db/posts/${VALID_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ _id: VALID_ID, ownerId: "owner-id" });
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("returns 404 without a second fetch when the (already-fetched) document doesn't exist", async () => {
    getDocument.mockResolvedValue(null);
    const app = createApp({ dbRules: { "/posts": { read: true } } });

    const res = await request(app).get(`/projects/test/db/posts/${VALID_ID}`);

    expect(res.status).toBe(404);
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("falls back to its own fetch on the req.isDbAdmin path, unaffected and still just one call", async () => {
    getDocument.mockResolvedValue({ _id: VALID_ID, ownerId: "someone-else" });
    // Deliberately empty dbRules: if the admin bypass ever stopped short-
    // circuiting, default-deny would turn this into a 403 and expose it.
    const app = createApp({ isDbAdmin: true, dbRules: {} });

    const res = await request(app).get(`/projects/test/db/posts/${VALID_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ _id: VALID_ID, ownerId: "someone-else" });
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("denies with 403 and never reaches the handler when the rule denies (default-deny)", async () => {
    getDocument.mockResolvedValue({ _id: VALID_ID, ownerId: "someone-else" });
    const app = createApp({ dbRules: {} });

    const res = await request(app).get(`/projects/test/db/posts/${VALID_ID}`);

    expect(res.status).toBe(403);
    // documentMiddleware still fetched once to run the check; the handler
    // itself never ran, so there's no second call either way.
    expect(getDocument).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /:col/:id document fetch dedup", () => {
  it("calls getDocument exactly once for a non-admin request (reuses documentMiddleware's fetch)", async () => {
    getDocument.mockResolvedValue({ _id: VALID_ID, ownerId: "owner-id" });
    deleteDocument.mockResolvedValue({ deletedCount: 1 });
    getCollectionsList.mockResolvedValue({ collections: [{ name: "posts", documentsCount: 0 }] });
    const app = createApp({ dbRules: { "/posts": { read: true, delete: true } } });

    const res = await request(app).delete(`/projects/test/db/posts/${VALID_ID}`);

    expect(res.status).toBe(200);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(deleteDocument).toHaveBeenCalledTimes(1);
  });

  it("falls back to its own fetch on the req.isDbAdmin path, unaffected and still just one call", async () => {
    getDocument.mockResolvedValue({ _id: VALID_ID, ownerId: "someone-else" });
    deleteDocument.mockResolvedValue({ deletedCount: 1 });
    getCollectionsList.mockResolvedValue({ collections: [{ name: "posts", documentsCount: 0 }] });
    const app = createApp({ isDbAdmin: true, dbRules: {} });

    const res = await request(app).delete(`/projects/test/db/posts/${VALID_ID}`);

    expect(res.status).toBe(200);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(deleteDocument).toHaveBeenCalledTimes(1);
  });

  it("denies with 403 and never calls deleteDocument when the rule denies (default-deny)", async () => {
    getDocument.mockResolvedValue({ _id: VALID_ID, ownerId: "someone-else" });
    const app = createApp({ dbRules: {} });

    const res = await request(app).delete(`/projects/test/db/posts/${VALID_ID}`);

    expect(res.status).toBe(403);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(deleteDocument).not.toHaveBeenCalled();
  });
});
