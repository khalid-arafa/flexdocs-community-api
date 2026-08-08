// Coverage for K3: the tokenVersion revocation mechanism.
//
// FlexDocs user JWTs are pure sign/verify with no denylist or session store
// (utils/encryptions.js), so tokenVersion on the user document is the entire
// revocation mechanism. These tests cover:
//   - a token issued before any revocation still verifies (version 0 vs 0)
//   - a token invalidated by /revoke-tokens is rejected afterward, in both
//     the REST checkDbUserApiAuth path and the socket paths
//   - /revoke-tokens and /refresh-token behave correctly at the route level
//
// (A full mint-then-re-verify round trip for /refresh-token lives in its own
// file, token_refresh_roundtrip.test.js, so it can use the real encryptions
// module without affecting the mocks used here.)

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");
jest.mock("../utils/encryptions");
jest.mock("../sockets/io_connect", () => ({ getIO: () => ({ to: jest.fn() }) }));
jest.mock("../middleware/db_rules.middleware", () => ({
  socketDocGuard: jest.fn(),
  socketColGuard: jest.fn(),
  socketAdminGuard: jest.fn(),
}));

const { getDocument, updateDocument } = require("../core/db_service");
const { verifyToken, getToken } = require("../utils/encryptions");

afterEach(() => jest.clearAllMocks());

// ─── checkDbUserApiAuth (REST) ───────────────────────────────────────────────

describe("checkDbUserApiAuth tokenVersion check", () => {
  const { checkDbUserApiAuth } = require("../middleware/user_auth.middleware");

  function makeReq(token) {
    return {
      cookies: {},
      headers: { authorization: `Bearer ${token}` },
      project: { code: "proj1", userId: "owner" },
    };
  }

  it("accepts a pre-existing token (no tokenVersion claim) against a user with no tokenVersion field — both default to 0", async () => {
    verifyToken.mockReturnValue({ userId: "u1", project: "proj1" }); // no tokenVersion claim
    getDocument.mockResolvedValue({ _id: "u1", email: "a@test.com" }); // no tokenVersion field
    const req = makeReq("legacy-token");
    const next = jest.fn();

    await checkDbUserApiAuth(req, {}, next);

    expect(req.sender).toBeDefined();
    expect(req.sender._id).toBe("u1");
    expect(next).toHaveBeenCalled();
  });

  it("accepts a token whose tokenVersion claim matches the user's current stored value", async () => {
    verifyToken.mockReturnValue({ userId: "u1", project: "proj1", tokenVersion: 2 });
    getDocument.mockResolvedValue({ _id: "u1", tokenVersion: 2 });
    const req = makeReq("current-token");
    const next = jest.fn();

    await checkDbUserApiAuth(req, {}, next);

    expect(req.sender).toBeDefined();
  });

  it("rejects (does not set req.sender) once the token has been revoked", async () => {
    // Token was minted at tokenVersion 0 ...
    verifyToken.mockReturnValue({ userId: "u1", project: "proj1", tokenVersion: 0 });
    // ... but /revoke-tokens has since bumped the stored value to 1.
    getDocument.mockResolvedValue({ _id: "u1", tokenVersion: 1 });
    const req = makeReq("revoked-token");
    const next = jest.fn();

    await checkDbUserApiAuth(req, {}, next);

    expect(req.sender).toBeUndefined();
    expect(next).toHaveBeenCalled(); // falls through unauthenticated, same as any bad token
  });

  it("still rejects a project-mismatched token before it would even reach the version check", async () => {
    verifyToken.mockReturnValue({ userId: "u1", project: "other-project", tokenVersion: 0 });
    const req = makeReq("cross-project-token");
    const next = jest.fn();

    await checkDbUserApiAuth(req, {}, next);

    expect(getDocument).not.toHaveBeenCalled();
    expect(req.sender).toBeUndefined();
  });
});

// ─── socketAuth (project-token + user-token socket handshake) ──────────────

describe("socketAuth tokenVersion check", () => {
  const { socketAuth } = require("../middleware/socket_auth.middleware");

  function socketWith(userToken) {
    return {
      handshake: {
        auth: { projectToken: "proj-jwt", userToken },
      },
    };
  }

  it("sets socket.sender for a pre-existing token (version 0 vs absent field)", async () => {
    verifyToken.mockImplementation((token) => {
      if (token === "proj-jwt") return { projectId: "id", name: "n", code: "myproj" };
      if (token === "user-jwt") return { userId: "u1", project: "myproj" }; // no claim
      return null;
    });
    getDocument.mockImplementation(async ({ collectionName, query }) => {
      if (collectionName === "projects") return { code: "myproj", userId: "owner", isActive: true };
      if (query && query._id === "u1") return { _id: "u1" }; // no tokenVersion field
      return null;
    });

    const socket = socketWith("user-jwt");
    const next = jest.fn();
    await socketAuth(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.sender).toBeDefined();
    expect(socket.sender._id).toBe("u1");
  });

  it("does not set socket.sender once the user token has been revoked", async () => {
    verifyToken.mockImplementation((token) => {
      if (token === "proj-jwt") return { projectId: "id", name: "n", code: "myproj" };
      if (token === "user-jwt") return { userId: "u1", project: "myproj", tokenVersion: 0 };
      return null;
    });
    getDocument.mockImplementation(async ({ collectionName, query }) => {
      if (collectionName === "projects") return { code: "myproj", userId: "owner", isActive: true };
      if (query && query._id === "u1") return { _id: "u1", tokenVersion: 1 }; // revoked
      return null;
    });

    const socket = socketWith("user-jwt");
    const next = jest.fn();
    await socketAuth(socket, next);

    // The socket itself is still valid (project token was fine) — only the
    // user session must be rejected, same as any other invalid user token.
    expect(next).toHaveBeenCalledWith();
    expect(socket.sender).toBeUndefined();
  });
});

// ─── db.sockets.js "set-user-token" handler ──────────────────────────────────

describe('db.sockets.js "set-user-token" tokenVersion check', () => {
  const { dbSockets } = require("../sockets/db.sockets");

  function createConnectedSocket() {
    const handlers = {};
    const socket = {
      id: "sock1",
      project: { code: "myproj", userId: "owner" },
      on: (event, handler) => { handlers[event] = handler; },
      join: jest.fn(),
      emit: jest.fn(),
    };
    let connectionHandler;
    dbSockets({ on: (event, cb) => { if (event === "connection") connectionHandler = cb; } });
    connectionHandler(socket);
    return { socket, handlers };
  }

  it("sets socket.sender for a still-valid (matching tokenVersion) token", async () => {
    verifyToken.mockReturnValue({ userId: "u1", project: "myproj", tokenVersion: 3 });
    getDocument.mockResolvedValue({ _id: "u1", tokenVersion: 3 });

    const { socket, handlers } = createConnectedSocket();
    await handlers["set-user-token"]("some-token");

    expect(socket.sender).toBeDefined();
    expect(socket.sender._id).toBe("u1");
  });

  it("leaves socket.sender unset for a revoked token", async () => {
    verifyToken.mockReturnValue({ userId: "u1", project: "myproj", tokenVersion: 0 });
    getDocument.mockResolvedValue({ _id: "u1", tokenVersion: 5 }); // revoked several times since

    const { socket, handlers } = createConnectedSocket();
    await handlers["set-user-token"]("revoked-token");

    expect(socket.sender).toBeUndefined();
  });
});

// ─── auth.routes.js: /revoke-tokens and /refresh-token ──────────────────────

describe("auth.routes.js revoke/refresh endpoints", () => {
  jest.mock("../core/auth_service");
  jest.mock("../sockets/auth.sockets", () => ({ sendAuthSocketEvent: jest.fn() }));
  jest.mock("../middleware/rate_limit.middleware", () => ({
    anonLoginLimiter: (_req, _res, next) => next(),
    authLimiter: (_req, _res, next) => next(),
    apiLimiter: (_req, _res, next) => next(),
  }));

  const request = require("supertest");
  const express = require("express");

  // checkDbUserApiAuth runs for real here (it is not mocked in this describe).
  // With no Authorization header on the test request it is a no-op that
  // leaves req.sender exactly as this test app's own middleware set it, so
  // these tests exercise the route handlers themselves against a
  // known-already-authenticated req.sender.
  function createApp({ sender } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.project = { code: "testproject", userId: "_system" };
      req.sender = sender;
      next();
    });
    app.use("/", require("../routes/auth.routes"));
    return app;
  }

  describe("POST /revoke-tokens", () => {
    it("increments tokenVersion for the signed-in user", async () => {
      const sender = { _id: "user-id", tokenVersion: 2 };
      updateDocument.mockResolvedValue({ modifiedCount: 1 });

      const res = await request(createApp({ sender })).post("/revoke-tokens");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(updateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { _id: "user-id" },
          updateData: { tokenVersion: 3 },
        }),
      );
    });

    it("treats an absent tokenVersion field as 0 before incrementing", async () => {
      const sender = { _id: "user-id" };
      updateDocument.mockResolvedValue({ modifiedCount: 1 });

      await request(createApp({ sender })).post("/revoke-tokens");

      expect(updateDocument).toHaveBeenCalledWith(
        expect.objectContaining({ updateData: { tokenVersion: 1 } }),
      );
    });

    it("returns 400 when there is no signed-in sender", async () => {
      const res = await request(createApp({ sender: null })).post("/revoke-tokens");
      expect(res.status).toBe(400);
      expect(updateDocument).not.toHaveBeenCalled();
    });
  });

  describe("POST /refresh-token", () => {
    it("returns a fresh token embedding the user's current tokenVersion", async () => {
      const sender = { _id: "user-id", tokenVersion: 4 };
      getToken.mockReturnValue("brand-new-jwt");

      const res = await request(createApp({ sender })).post("/refresh-token");

      expect(res.status).toBe(200);
      expect(res.body.token).toBe("brand-new-jwt");
      expect(getToken).toHaveBeenCalledWith({
        userId: "user-id",
        project: "testproject",
        tokenVersion: 4,
      });
    });

    it("returns 401 when there is no signed-in sender (invalid/expired token)", async () => {
      const res = await request(createApp({ sender: null })).post("/refresh-token");
      expect(res.status).toBe(401);
      expect(getToken).not.toHaveBeenCalled();
    });
  });
});
