// Bulk-authorization TOCTOU regression.
//
// bulkMiddleware rule-checks the documents matching the caller's filter, but
// the write in db.routes.js runs `updateMany(req.body.filter)` /
// `deleteMany(req.body.filter)` afterwards. A document inserted (or edited into
// the filter's range) between the two was written without ever being
// rule-checked. The middleware now rewrites `req.body.filter` in place to the
// exact ids that passed, so the route's unchanged code writes only to the
// authorized set.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
// Needed by requireActual("../core/db_service") below: the real module builds a
// MongoClient at import time.
jest.mock("../core/client");
jest.mock("../core/db_service", () => ({
  getDocument: jest.fn(),
  getManyDocuments: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock("../utils/encryptions", () => ({ verifyToken: jest.fn() }));

const { ObjectId } = require("mongodb");
const { bulkMiddleware } = require("../middleware/db_rules.middleware");
const { getManyDocuments, countDocuments } = require("../core/db_service");
const { formatQueryObj } = jest.requireActual("../core/db_service");
const { updateManySchema } = require("../utils/schemas");
const { mockReq, mockRes } = require("./helpers/express-mocks");

// Real DbRulesService is used (not mocked) so the rules below behave exactly as
// they would in production — default-deny included.
const ALLOW_ALL = { "/posts": true };

function bulkReq({ method = "PUT", body, dbRules = ALLOW_ALL, ...rest } = {}) {
  return mockReq({
    method,
    params: { col: "posts" },
    body,
    project: { name: "T", code: "test", userId: "testuser", dbRules },
    ...rest,
  });
}

// The documents the filter matched at check time.
function matching(docs) {
  countDocuments.mockResolvedValue(docs.length);
  getManyDocuments.mockResolvedValue(docs);
  return docs;
}

beforeEach(() => jest.clearAllMocks());

describe("bulkMiddleware narrows the write to the checked documents", () => {
  it("ANDs the caller's filter with the ids that passed (PUT)", async () => {
    const ids = [new ObjectId(), new ObjectId()];
    matching(ids.map((_id) => ({ _id, status: "draft" })));

    const req = bulkReq({ body: { filter: { status: "draft" }, newData: { status: "x" } } });
    const next = jest.fn();
    await bulkMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.body.filter).toEqual({
      $and: [{ status: "draft" }, { _id: { $in: ids } }],
    });
  });

  // The actual race: a document created after the check must not be written.
  it("excludes a document that appears after the check", async () => {
    const checked = [new ObjectId(), new ObjectId()];
    const insertedLater = new ObjectId();
    matching(checked.map((_id) => ({ _id })));

    const req = bulkReq({ body: { filter: { status: "draft" }, newData: { status: "x" } } });
    await bulkMiddleware(req, mockRes(), jest.fn());

    const authorized = req.body.filter.$and[1]._id.$in.map(String);
    expect(authorized).toEqual(checked.map(String));
    expect(authorized).not.toContain(String(insertedLater));
  });

  it("uses a bare id clause when the caller's filter is empty", async () => {
    const ids = [new ObjectId()];
    matching(ids.map((_id) => ({ _id })));

    const req = bulkReq({ body: { filter: {}, newData: { a: 1 } } });
    await bulkMiddleware(req, mockRes(), jest.fn());

    expect(req.body.filter).toEqual({ _id: { $in: ids } });
  });

  it("also narrows a bulk DELETE", async () => {
    const ids = [new ObjectId()];
    matching(ids.map((_id) => ({ _id })));

    const req = bulkReq({ method: "DELETE", body: { filter: { status: "old" } } });
    const next = jest.fn();
    await bulkMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.body.filter.$and[1]).toEqual({ _id: { $in: ids } });
  });

  // "Nothing matched, so it's a no-op" is exactly the assumption the race
  // exploits — the empty set has to be pinned too.
  it("pins the write to the empty set when nothing matched", async () => {
    matching([]);

    const req = bulkReq({ body: { filter: { status: "draft" }, newData: { a: 1 } } });
    const next = jest.fn();
    await bulkMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.body.filter).toEqual({ $and: [{ status: "draft" }, { _id: { $in: [] } }] });
    expect(getManyDocuments).not.toHaveBeenCalled();
  });

  it("exposes the authorized ids on the request as well", async () => {
    const ids = [new ObjectId()];
    matching(ids.map((_id) => ({ _id })));

    const req = bulkReq({ body: { filter: {}, newData: { a: 1 } } });
    await bulkMiddleware(req, mockRes(), jest.fn());

    expect(req.authorizedBulkIds).toEqual(ids);
  });
});

describe("bulkMiddleware leaves the rest of the contract alone", () => {
  it("does not add a filter to a DELETE that has none (the route's 400 must stand)", async () => {
    matching([{ _id: new ObjectId() }]);

    const req = bulkReq({ method: "DELETE", body: {} });
    const next = jest.fn();
    await bulkMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.body.filter).toBeUndefined();
  });

  it("does not touch the body when a document fails the rules", async () => {
    matching([{ _id: new ObjectId(), ownerId: "u1" }, { _id: new ObjectId(), ownerId: "u2" }]);

    const req = bulkReq({
      body: { filter: { status: "draft" }, newData: { a: 1 } },
      dbRules: { "/posts": { update: "user.uid == doc.ownerId" } },
      sender: { uid: "u1" },
    });
    const res = mockRes();
    const next = jest.fn();
    await bulkMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.body.filter).toEqual({ status: "draft" });
  });

  it("does not touch the body for a db admin (middleware short-circuits)", async () => {
    const req = bulkReq({ body: { filter: { status: "draft" }, newData: { a: 1 } }, isDbAdmin: true });
    const next = jest.fn();
    await bulkMiddleware(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.body.filter).toEqual({ status: "draft" });
    expect(countDocuments).not.toHaveBeenCalled();
  });

  it("still refuses a filter matching more than the rule-check limit", async () => {
    countDocuments.mockResolvedValue(1001);

    const req = bulkReq({ body: { filter: {}, newData: { a: 1 } } });
    const res = mockRes();
    const next = jest.fn();
    await bulkMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// The handoff is only real if the narrowed filter survives everything the route
// puts it through before it reaches Mongo.
describe("the narrowed filter survives the downstream pipeline", () => {
  it("passes updateManySchema, which zodValidate runs after this middleware", async () => {
    const ids = [new ObjectId()];
    matching(ids.map((_id) => ({ _id })));

    const req = bulkReq({ body: { filter: { status: "draft" }, newData: { a: 1 } } });
    await bulkMiddleware(req, mockRes(), jest.fn());

    const parsed = updateManySchema.safeParse(req.body);
    expect(parsed.success).toBe(true);
    expect(parsed.data.filter).toEqual(req.body.filter);
  });

  it("survives formatQueryObj with ids coerced back to ObjectId", async () => {
    const ids = [new ObjectId(), new ObjectId()];
    matching(ids.map((_id) => ({ _id })));

    const req = bulkReq({ body: { filter: { status: "draft" }, newData: { a: 1 } } });
    await bulkMiddleware(req, mockRes(), jest.fn());

    // formatQueryObj JSON round-trips its input, which turns an ObjectId into
    // its hex string; the $in coercion has to turn it back or the write would
    // match nothing.
    const formatted = formatQueryObj(req.body.filter);
    const coerced = formatted.$and[1]._id.$in;
    expect(coerced.every((id) => id instanceof ObjectId)).toBe(true);
    expect(coerced.map(String)).toEqual(ids.map(String));
  });

  it("keeps a non-ObjectId string _id as a string", async () => {
    matching([{ _id: "custom-string-id" }]);

    const req = bulkReq({ body: { filter: {}, newData: { a: 1 } } });
    await bulkMiddleware(req, mockRes(), jest.fn());

    expect(formatQueryObj(req.body.filter)).toEqual({
      _id: { $in: ["custom-string-id"] },
    });
  });
});
