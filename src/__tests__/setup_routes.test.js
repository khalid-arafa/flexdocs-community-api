jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));
jest.mock("../core/db_service");
jest.mock("../core/auth_service");
// POST /setup now claims the one-time admin-bootstrap slot atomically before
// creating anything, and that claim is a real insert through getUserDB rather
// than a db_service call — so it has to be mocked here too, or the route waits
// on a live Mongo connection that never arrives.
jest.mock("../utils/setup_lock", () => ({
  claimSetupSlot: jest.fn().mockResolvedValue(true),
  releaseSetupSlot: jest.fn().mockResolvedValue(undefined),
}));
// passthrough rate limiter so tests aren't throttled
jest.mock("../middleware/rate_limit.middleware", () => ({
  authLimiter: (_req, _res, next) => next(),
  anonLoginLimiter: (_req, _res, next) => next(),
  apiLimiter: (_req, _res, next) => next(),
}));

const request = require("supertest");
const express = require("express");

const { countDocuments } = require("../core/db_service");
const { registerWithEmailAndPassword } = require("../core/auth_service");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", require("../routes/setup.routes"));
  return app;
}

const VALID_BODY = {
  name: "Admin",
  email: "admin@example.com",
  password: "Passw0rd!",
  confirmPassword: "Passw0rd!",
  token: "secret-token",
};

describe("Setup Routes", () => {
  beforeEach(() => {
    process.env.SETUP_TOKEN = "secret-token";
    process.env.APP_NAME = "TestApp";
  });
  afterEach(() => jest.clearAllMocks());

  // ── GET /setup/status ──────────────────────────────────────────────────────
  describe("GET /setup/status", () => {
    it("returns needsSetup:true when no admin exists", async () => {
      countDocuments.mockResolvedValue(0);
      const res = await request(makeApp()).get("/setup/status");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ needsSetup: true });
    });

    it("returns needsSetup:false when an admin already exists", async () => {
      countDocuments.mockResolvedValue(1);
      const res = await request(makeApp()).get("/setup/status");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ needsSetup: false });
    });
  });

  // ── POST /setup ────────────────────────────────────────────────────────────
  describe("POST /setup", () => {
    it("creates the admin with roles:[admin] when token matches and setup is needed", async () => {
      countDocuments.mockResolvedValue(0);
      registerWithEmailAndPassword.mockResolvedValue({ uid: "1" });
      const res = await request(makeApp()).post("/setup").send(VALID_BODY);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(registerWithEmailAndPassword).toHaveBeenCalledTimes(1);
      expect(registerWithEmailAndPassword.mock.calls[0][0]).toMatchObject({
        email: "admin@example.com",
        roles: ["admin"],
      });
    });

    it("rejects with 403 when setup is already complete", async () => {
      countDocuments.mockResolvedValue(1); // admin exists
      const res = await request(makeApp()).post("/setup").send(VALID_BODY);
      expect(res.status).toBe(403);
      expect(registerWithEmailAndPassword).not.toHaveBeenCalled();
    });

    it("rejects with 403 on a wrong token", async () => {
      countDocuments.mockResolvedValue(0);
      const res = await request(makeApp())
        .post("/setup")
        .send({ ...VALID_BODY, token: "wrong-token" });
      expect(res.status).toBe(403);
      expect(registerWithEmailAndPassword).not.toHaveBeenCalled();
    });

    it("rejects with 403 when SETUP_TOKEN is not configured on the server", async () => {
      delete process.env.SETUP_TOKEN;
      countDocuments.mockResolvedValue(0);
      const res = await request(makeApp()).post("/setup").send(VALID_BODY);
      expect(res.status).toBe(403);
      expect(registerWithEmailAndPassword).not.toHaveBeenCalled();
    });

    it("rejects with 400 when passwords do not match (zod)", async () => {
      countDocuments.mockResolvedValue(0);
      const res = await request(makeApp())
        .post("/setup")
        .send({ ...VALID_BODY, confirmPassword: "Different1!" });
      expect(res.status).toBe(400);
      expect(registerWithEmailAndPassword).not.toHaveBeenCalled();
    });

    it("rejects with 400 on a weak password (zod)", async () => {
      countDocuments.mockResolvedValue(0);
      const res = await request(makeApp())
        .post("/setup")
        .send({ ...VALID_BODY, password: "weak", confirmPassword: "weak" });
      expect(res.status).toBe(400);
      expect(registerWithEmailAndPassword).not.toHaveBeenCalled();
    });
  });
});

// The claim is what makes setup one-time under concurrency; needsSetup() alone
// is a read and two simultaneous callers both pass it.
describe("POST /setup one-time claim", () => {
  const { claimSetupSlot, releaseSetupSlot } = require("../utils/setup_lock");

  beforeEach(() => {
    process.env.SETUP_TOKEN = "secret-token";
    jest.clearAllMocks();
    countDocuments.mockResolvedValue(0);
    claimSetupSlot.mockResolvedValue(true);
    releaseSetupSlot.mockResolvedValue(undefined);
  });

  it("refuses the caller that loses the claim, even though setup looked needed", async () => {
    claimSetupSlot.mockResolvedValue(false);
    const res = await request(makeApp()).post("/setup").send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(registerWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it("claims before creating the admin, never after", async () => {
    const order = [];
    claimSetupSlot.mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    registerWithEmailAndPassword.mockImplementation(async () => {
      order.push("create");
      return { uid: "1" };
    });
    await request(makeApp()).post("/setup").send(VALID_BODY);
    expect(order).toEqual(["claim", "create"]);
  });

  // Otherwise one rejected password on the first-ever attempt would lock the
  // system out of creating an admin at all.
  it("releases the claim when creating the admin fails", async () => {
    registerWithEmailAndPassword.mockRejectedValue(new Error("weak password"));
    const res = await request(makeApp()).post("/setup").send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(releaseSetupSlot).toHaveBeenCalled();
  });

  it("keeps the claim when the admin is created successfully", async () => {
    registerWithEmailAndPassword.mockResolvedValue({ uid: "1" });
    await request(makeApp()).post("/setup").send(VALID_BODY);
    expect(releaseSetupSlot).not.toHaveBeenCalled();
  });
});
