jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

// Mock core dependencies before requiring the router
jest.mock("../core/auth_service");
jest.mock("../core/db_service");
jest.mock("../sockets/auth.sockets", () => ({ sendAuthSocketEvent: jest.fn() }));
jest.mock("../utils/encryptions");
jest.mock("../middleware/rate_limit.middleware", () => ({
  anonLoginLimiter: (_req, _res, next) => next(),
  authLimiter: (_req, _res, next) => next(),
  apiLimiter: (_req, _res, next) => next(),
}));
jest.mock("../middleware/user_auth.middleware", () => ({
  checkDbUserApiAuth: jest.fn((_req, _res, next) => next()),
}));

const request = require("supertest");
const express = require("express");

const {
  loginWithEmailAndPassword,
  registerWithEmailAndPassword,
  loginWithToken,
  anonymousLogin,
  changePassword,
  sendVerifyEmail,
  sendResetPasswordEmail,
} = require("../core/auth_service");
const { getManyDocuments, countDocuments, getDocument } = require("../core/db_service");
const { hashPassword } = require("../utils/encryptions");
const { checkDbUserApiAuth } = require("../middleware/user_auth.middleware");

// ─── test app factory ────────────────────────────────────────────────────────

function createApp({ byAdmin = false, sender = { _id: "user-id", email: "u@test.com" } } = {}) {
  const app = express();
  app.use(express.json());

  // Simulate project-auth and sender injection (normally done by middleware)
  app.use((req, _res, next) => {
    req.project = {
      code: "testproject",
      userId: "_system",
      authRules: {}, // use defaultAuthRules throughout
    };
    req.isDbAdmin = byAdmin;
    req.byAdmin = byAdmin;
    req.sender = sender;
    next();
  });

  const authRouter = require("../routes/auth.routes");
  app.use("/", authRouter);

  return app;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("auth.routes.js", () => {
  afterEach(() => jest.clearAllMocks());

  // ── POST /register-with-email ─────────────────────────────────────────────

  describe("POST /register-with-email", () => {
    it("should return 200 with user on successful registration", async () => {
      registerWithEmailAndPassword.mockResolvedValue({
        token: "jwt",
        uid: "user-id",
        email: "new@example.com",
      });
      const res = await request(createApp())
        .post("/register-with-email")
        .send({ email: "new@example.com", password: "Password1!" });
      expect(res.status).toBe(200);
      expect(res.body.token).toBe("jwt");
    });

    it("should return 400 when email is missing (Zod)", async () => {
      const res = await request(createApp())
        .post("/register-with-email")
        .send({ password: "Password1!" });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("errors");
    });

    it("should return 400 when password is missing (Zod)", async () => {
      const res = await request(createApp())
        .post("/register-with-email")
        .send({ email: "new@example.com" });
      expect(res.status).toBe(400);
    });

    it("should return 400 with message when email is already registered", async () => {
      registerWithEmailAndPassword.mockRejectedValue(
        new Error("This email is already registered!")
      );
      const res = await request(createApp())
        .post("/register-with-email")
        .send({ email: "existing@example.com", password: "Password1!" });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("already registered");
    });
  });

  // ── POST /login-with-email ─────────────────────────────────────────────────

  describe("POST /login-with-email", () => {
    it("should return 200 with user on successful login", async () => {
      loginWithEmailAndPassword.mockResolvedValue({
        token: "jwt",
        uid: "user-id",
        email: "u@test.com",
        emailVerified: true,
      });
      const res = await request(createApp())
        .post("/login-with-email")
        .send({ email: "u@test.com", password: "Password1!" });
      expect(res.status).toBe(200);
      expect(res.body.token).toBe("jwt");
    });

    it("should return 400 with generic message when credentials are wrong", async () => {
      loginWithEmailAndPassword.mockRejectedValue(new Error("Invalid email or password"));
      const res = await request(createApp())
        .post("/login-with-email")
        .send({ email: "u@test.com", password: "wrongpass" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Invalid email or password");
    });

    it("should NOT expose 'not registered' in login error (enumeration prevention)", async () => {
      loginWithEmailAndPassword.mockRejectedValue(new Error("Invalid email or password"));
      const res = await request(createApp())
        .post("/login-with-email")
        .send({ email: "ghost@example.com", password: "Password1!" });
      expect(res.body.message).not.toContain("not registered");
    });

    it("should return 400 when account is locked", async () => {
      loginWithEmailAndPassword.mockRejectedValue(
        new Error("Account is temporarily locked due to too many failed attempts. Try again later.")
      );
      const res = await request(createApp())
        .post("/login-with-email")
        .send({ email: "u@test.com", password: "Password1!" });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("temporarily locked");
    });

    it("should return 403 when email verification is required but not done", async () => {
      loginWithEmailAndPassword.mockResolvedValue({
        token: "jwt",
        uid: "user-id",
        email: "u@test.com",
        emailVerified: false,
      });
      const app = createApp();
      // Override authRules to require verification
      app.use((req, _res, next) => {
        req.project.authRules = { requireEmailVerification: true };
        next();
      });
      // Re-register the router after override — use a fresh app instead
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use((req, _res, next) => {
        req.project = {
          code: "testproject",
          userId: "_system",
          authRules: { requireEmailVerification: true },
        };
        req.isDbAdmin = false;
        req.byAdmin = false;
        next();
      });
      freshApp.use("/", require("../routes/auth.routes"));

      const res = await request(freshApp)
        .post("/login-with-email")
        .send({ email: "u@test.com", password: "Password1!" });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain("verify your email");
    });
  });

  // ── POST /login-with-token ────────────────────────────────────────────────

  describe("POST /login-with-token", () => {
    it("should return 200 with user on valid token", async () => {
      loginWithToken.mockResolvedValue({ token: "jwt", uid: "user-id" });
      const res = await request(createApp())
        .post("/login-with-token")
        .send({ token: "some-jwt-token" });
      expect(res.status).toBe(200);
      expect(res.body.uid).toBe("user-id");
    });

    it("should return 400 when token is missing (Zod)", async () => {
      const res = await request(createApp()).post("/login-with-token").send({});
      expect(res.status).toBe(400);
    });

    it("should return 400 when token is invalid", async () => {
      loginWithToken.mockRejectedValue(new Error("User not found!"));
      const res = await request(createApp())
        .post("/login-with-token")
        .send({ token: "bad-token" });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /anonymous-login ─────────────────────────────────────────────────

  describe("POST /anonymous-login", () => {
    it("should return 200 with anonymous user", async () => {
      anonymousLogin.mockResolvedValue({ token: "jwt", uid: "anon-id" });
      // Anonymous login is now OFF by default — enable it for this project.
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.project = {
          code: "testproject",
          userId: "_system",
          authRules: { allowAnonymousLogin: true },
        };
        next();
      });
      app.use("/", require("../routes/auth.routes"));
      const res = await request(app).post("/anonymous-login").send({});
      expect(res.status).toBe(200);
      expect(res.body.uid).toBe("anon-id");
    });

    it("should return 403 when anonymous login is disabled", async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.project = {
          code: "testproject",
          userId: "_system",
          authRules: { allowAnonymousLogin: false },
        };
        next();
      });
      app.use("/", require("../routes/auth.routes"));
      const res = await request(app).post("/anonymous-login").send({});
      expect(res.status).toBe(403);
    });
  });

  // ── POST /change-password ─────────────────────────────────────────────────

  describe("POST /change-password", () => {
    beforeEach(() => {
      checkDbUserApiAuth.mockImplementation((req, _res, next) => {
        req.sender = { _id: "user-id" };
        next();
      });
    });

    it("should return 200 on successful password change", async () => {
      changePassword.mockResolvedValue({ modifiedCount: 1 });
      const res = await request(createApp())
        .post("/change-password")
        .send({ oldPassword: "OldPass1!", newPassword: "NewPass1!" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should return 400 with Zod error when newPassword is too weak", async () => {
      const res = await request(createApp())
        .post("/change-password")
        .send({ oldPassword: "OldPass1!", newPassword: "weak" });
      expect(res.status).toBe(400);
    });

    it("should return 400 when old password is wrong", async () => {
      changePassword.mockRejectedValue(new Error("Old password is incorrect!"));
      const res = await request(createApp())
        .post("/change-password")
        .send({ oldPassword: "WrongOld1!", newPassword: "NewPass1!" });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("incorrect");
    });
  });

  // ── POST /send-reset-password-email ──────────────────────────────────────

  describe("POST /send-reset-password-email", () => {
    it("should always return the same message regardless of email existence", async () => {
      sendResetPasswordEmail.mockResolvedValue(true);
      const res = await request(createApp())
        .post("/send-reset-password-email")
        .send({ email: "any@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain("If your email is registered");
    });

    it("should return the same message even when account is not found", async () => {
      sendResetPasswordEmail.mockResolvedValue(false);
      const res = await request(createApp())
        .post("/send-reset-password-email")
        .send({ email: "notfound@example.com" });
      expect(res.status).toBe(200);
      // The response must NOT reveal whether the email exists
      expect(res.body.message).toContain("If your email is registered");
    });

    it("should return 400 when email is missing", async () => {
      const res = await request(createApp())
        .post("/send-reset-password-email")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  // ── POST /auth/accounts (admin only) ──────────────────────────────────────

  describe("POST /accounts (admin)", () => {
    it("should return 403 when requester is not admin", async () => {
      const res = await request(createApp({ byAdmin: false }))
        .post("/accounts")
        .send({});
      expect(res.status).toBe(403);
    });

    it("should return 201 with accounts list when admin", async () => {
      getManyDocuments.mockResolvedValue([
        { _id: "u1", email: "a@test.com" },
      ]);
      countDocuments.mockResolvedValue(1);
      const res = await request(createApp({ byAdmin: true }))
        .post("/accounts")
        .send({});
      expect(res.status).toBe(201);
      expect(Array.isArray(res.body.accounts)).toBe(true);
    });
  });

  // ── POST /accounts/add (admin only) ──────────────────────────────────────

  describe("POST /accounts/add (admin)", () => {
    it("should return 403 for non-admin", async () => {
      const res = await request(createApp({ byAdmin: false }))
        .post("/accounts/add")
        .send({ name: "A", email: "a@b.com", password: "pass" });
      expect(res.status).toBe(403);
    });

    it("should return 200 when admin adds a new account", async () => {
      registerWithEmailAndPassword.mockResolvedValue({ token: "jwt", uid: "new-id" });
      getDocument.mockResolvedValue({ _id: "new-id", email: "a@b.com" });
      const res = await request(createApp({ byAdmin: true }))
        .post("/accounts/add")
        .send({ name: "Alice", email: "a@b.com", password: "pass" });
      expect(res.status).toBe(200);
    });

    it("should return 400 when email is missing (Zod)", async () => {
      const res = await request(createApp({ byAdmin: true }))
        .post("/accounts/add")
        .send({ name: "Alice", password: "pass" });
      expect(res.status).toBe(400);
    });
  });
});
