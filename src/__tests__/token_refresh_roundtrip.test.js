// /refresh-token must return a token that itself verifies afterward. This
// exercises the real jsonwebtoken sign/verify in utils/encryptions.js (kept
// in its own file/module registry rather than sharing the one in
// token_version.test.js, which mocks encryptions and db_service for its own
// unit tests).

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/auth_service");
jest.mock("../sockets/auth.sockets", () => ({ sendAuthSocketEvent: jest.fn() }));
jest.mock("../middleware/rate_limit.middleware", () => ({
  anonLoginLimiter: (_req, _res, next) => next(),
  authLimiter: (_req, _res, next) => next(),
  apiLimiter: (_req, _res, next) => next(),
}));
jest.mock("../core/db_service", () => ({
  getDocument: jest.fn(),
  updateDocument: jest.fn(),
}));

const request = require("supertest");
const express = require("express");
const { getDocument } = require("../core/db_service");
const { verifyToken } = require("../utils/encryptions"); // real implementation
const { checkDbUserApiAuth } = require("../middleware/user_auth.middleware");
const authRouter = require("../routes/auth.routes");

function buildApp(project = { code: "proj1", userId: "owner" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = project;
    next();
  });
  app.use("/", authRouter);
  return app;
}

describe("POST /refresh-token round trip", () => {
  afterEach(() => jest.clearAllMocks());

  it("mints a token that checkDbUserApiAuth accepts again afterward, carrying the current tokenVersion", async () => {
    const user = { _id: "u1", tokenVersion: 0 };

    // First call: authenticate with an existing valid token to reach /refresh-token.
    getDocument.mockResolvedValue(user);
    const app = buildApp();

    // Build an initial valid token via the real signer, bypassing login flow.
    const { getToken } = require("../utils/encryptions");
    const initialToken = getToken({ userId: "u1", project: "proj1", tokenVersion: 0 });

    const refreshRes = await request(app)
      .post("/refresh-token")
      .set("Authorization", `Bearer ${initialToken}`);

    expect(refreshRes.status).toBe(200);
    expect(typeof refreshRes.body.token).toBe("string");

    // The new token must itself decode with the right claims...
    const decoded = verifyToken(refreshRes.body.token);
    expect(decoded.userId).toBe("u1");
    expect(decoded.project).toBe("proj1");
    expect(decoded.tokenVersion).toBe(0);

    // ...and must be accepted again by checkDbUserApiAuth.
    const verifyApp = express();
    verifyApp.use((req, _res, next) => {
      req.project = { code: "proj1", userId: "owner" };
      next();
    });
    verifyApp.use(checkDbUserApiAuth);
    verifyApp.get("/whoami", (req, res) => res.json({ hasSender: Boolean(req.sender) }));

    const whoamiRes = await request(verifyApp)
      .get("/whoami")
      .set("Authorization", `Bearer ${refreshRes.body.token}`);

    expect(whoamiRes.body.hasSender).toBe(true);
  });

  it("a refreshed token stops working once the user is revoked afterward", async () => {
    const user = { _id: "u1", tokenVersion: 0 };
    getDocument.mockResolvedValue(user);
    const { getToken } = require("../utils/encryptions");
    const initialToken = getToken({ userId: "u1", project: "proj1", tokenVersion: 0 });

    const app = buildApp();
    const refreshRes = await request(app)
      .post("/refresh-token")
      .set("Authorization", `Bearer ${initialToken}`);
    expect(refreshRes.status).toBe(200);

    // Simulate /revoke-tokens having bumped the stored tokenVersion since.
    getDocument.mockResolvedValue({ _id: "u1", tokenVersion: 1 });

    const verifyApp = express();
    verifyApp.use((req, _res, next) => {
      req.project = { code: "proj1", userId: "owner" };
      next();
    });
    verifyApp.use(checkDbUserApiAuth);
    verifyApp.get("/whoami", (req, res) => res.json({ hasSender: Boolean(req.sender) }));

    const whoamiRes = await request(verifyApp)
      .get("/whoami")
      .set("Authorization", `Bearer ${refreshRes.body.token}`);

    expect(whoamiRes.body.hasSender).toBe(false);
  });
});
