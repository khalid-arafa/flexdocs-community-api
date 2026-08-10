// C3: PUT /accounts/:id wrote the raw request body straight into the auth
// document. That let lockedUntil, failedLoginAttempts, tokenVersion and
// resetPasswordToken be overwritten by anything the caller sent — none of
// which any legitimate endpoint sets via client input. (The generic /:col
// and /:col/:id routes can never reach the auth collection at all —
// validateCollectionParam rejects "_users" — so this route is the one real
// call site; see auth_field_guard.js.) This pins the strip at the route
// level (real router, only Mongo access mocked).

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");
jest.mock("../sockets/auth.sockets.js", () => ({ sendAuthSocketEvent: jest.fn() }));
jest.mock("../utils/encryptions.js", () => ({
  hashPassword: jest.fn(async (p) => `hashed:${p}`),
  getToken: jest.fn(() => "mock-token"),
}));

const request = require("supertest");
const express = require("express");

const { getDocument, updateDocument } = require("../core/db_service");

const VALID_ID = "507f1f77bcf86cd799439011";

afterEach(() => jest.clearAllMocks());

describe("PUT /accounts/:id strips protected auth fields", () => {
  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.project = { code: "test", userId: "owner-id" };
      req.byAdmin = true;
      next();
    });
    const authRouter = require("../routes/auth.routes.js");
    app.use("/projects/test", authRouter);
    return app;
  }

  beforeEach(() => {
    updateDocument.mockResolvedValue({ matchedCount: 1 });
    getDocument.mockResolvedValue({ _id: VALID_ID, name: "Ada" });
  });

  it("removes lockedUntil/failedLoginAttempts/tokenVersion/resetPasswordToken from the body before updating", async () => {
    const app = createApp();
    await request(app)
      .put(`/projects/test/accounts/${VALID_ID}`)
      .send({
        name: "Ada",
        lockedUntil: null,
        failedLoginAttempts: 0,
        tokenVersion: 0,
        resetPasswordToken: null,
      });

    expect(updateDocument).toHaveBeenCalledTimes(1);
    const { updateData } = updateDocument.mock.calls[0][0];
    expect(updateData).toEqual({ name: "Ada" });
  });

  it("leaves other fields (e.g. roles) untouched", async () => {
    const app = createApp();
    await request(app)
      .put(`/projects/test/accounts/${VALID_ID}`)
      .send({ roles: ["admin"], tokenVersion: 99 });

    expect(updateDocument).toHaveBeenCalledTimes(1);
    const { updateData } = updateDocument.mock.calls[0][0];
    expect(updateData).toEqual({ roles: ["admin"] });
  });
});
