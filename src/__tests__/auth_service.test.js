jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock("../core/client");
jest.mock("../core/db_service");
jest.mock("../utils/encryptions");
jest.mock("../core/email_service", () => ({
  sendVerifyAccountEmail: jest.fn().mockResolvedValue(true),
  sendRecoverPasswordEmail: jest.fn().mockResolvedValue(true),
}));
jest.mock("../core/verification_service");

const { getUserDB } = require("../core/client");
const { getDocument, updateDocument } = require("../core/db_service");
const { hashPassword, verifyPassword, getToken, verifyToken } = require("../utils/encryptions");
const { generateVerificationToken } = require("../core/verification_service");

const {
  loginWithEmailAndPassword,
  registerWithEmailAndPassword,
  loginWithToken,
  anonymousLogin,
  changePassword,
  sendVerifyEmail,
  sendResetPasswordEmail,
} = require("../core/auth_service");

// ─── helpers ───────────────────────────────────────────────────────────────

const mockProject = { code: "testproj", userId: "user1" };

const makeUser = (overrides = {}) => ({
  _id: { toString: () => "user-id-123" },
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  emailVerified: true,
  roles: [],
  failedLoginAttempts: 0,
  ...overrides,
});

function makeMockDb(collectionOverrides = {}) {
  const mockCollection = {
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: { toString: () => "new-user-id" } }),
    createIndex: jest.fn().mockResolvedValue({}),
    ...collectionOverrides,
  };
  return { collection: jest.fn().mockReturnValue(mockCollection) };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe("auth_service.js", () => {
  beforeEach(() => {
    getUserDB.mockResolvedValue(makeMockDb());
    updateDocument.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    hashPassword.mockResolvedValue("$2b$12$hashed");
    getToken.mockReturnValue("mock-jwt-token");
    generateVerificationToken.mockReturnValue("mock-verify-token");
  });

  // ── loginWithEmailAndPassword ─────────────────────────────────────────────

  describe("loginWithEmailAndPassword", () => {
    const params = {
      userId: "user1",
      projectCode: "testproj",
      email: "test@example.com",
      password: "Password1!",
    };

    beforeEach(() => {
      getDocument.mockResolvedValue(makeUser());
      verifyPassword.mockResolvedValue({ match: true, needsRehash: false });
    });

    // success

    it("should return user object with token and uid on success", async () => {
      const user = await loginWithEmailAndPassword(params);
      expect(user.token).toBe("mock-jwt-token");
      expect(user.uid).toBe("user-id-123");
      expect(user.email).toBe("test@example.com");
    });

    it("should strip all sensitive and internal fields from the response", async () => {
      const user = await loginWithEmailAndPassword(params);
      expect(user._id).toBeUndefined();
      expect(user.password).toBeUndefined();
      expect(user.isActive).toBeUndefined();
      expect(user.createdAt).toBeUndefined();
      expect(user.lastLoginAt).toBeUndefined();
      expect(user.resetPasswordToken).toBeUndefined();
      expect(user.failedLoginAttempts).toBeUndefined();
      expect(user.lockedUntil).toBeUndefined();
    });

    // email enumeration prevention

    it("should throw 'Invalid email or password' when email is not found", async () => {
      getDocument.mockResolvedValue(null);
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow(
        "Invalid email or password"
      );
    });

    it("should NOT reveal that the email address does not exist", async () => {
      getDocument.mockResolvedValue(null);
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining("not registered") })
      );
    });

    it("should throw 'Invalid email or password' when password is wrong", async () => {
      verifyPassword.mockResolvedValue({ match: false, needsRehash: false });
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow(
        "Invalid email or password"
      );
    });

    it("should NOT reveal that the password is incorrect", async () => {
      verifyPassword.mockResolvedValue({ match: false, needsRehash: false });
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining("incorrect") })
      );
    });

    // account status

    it("should throw 'Your account is disabled' when isActive is false", async () => {
      getDocument.mockResolvedValue(makeUser({ isActive: false }));
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow(
        "Your account is disabled"
      );
    });

    // account lockout

    it("should throw lockout error when lockedUntil is in the future", async () => {
      getDocument.mockResolvedValue(
        makeUser({ lockedUntil: new Date(Date.now() + 60_000) })
      );
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow(
        "Account is temporarily locked"
      );
    });

    it("should allow login when lockedUntil is in the past", async () => {
      getDocument.mockResolvedValue(
        makeUser({ lockedUntil: new Date(Date.now() - 60_000), failedLoginAttempts: 10 })
      );
      const user = await loginWithEmailAndPassword(params);
      expect(user.token).toBe("mock-jwt-token");
    });

    it("should increment failedLoginAttempts by 1 on each wrong password", async () => {
      getDocument.mockResolvedValue(makeUser({ failedLoginAttempts: 3 }));
      verifyPassword.mockResolvedValue({ match: false, needsRehash: false });
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow();
      expect(updateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          updateData: expect.objectContaining({ failedLoginAttempts: 4 }),
        })
      );
    });

    it("should set lockedUntil on the 10th consecutive failure", async () => {
      getDocument.mockResolvedValue(makeUser({ failedLoginAttempts: 9 }));
      verifyPassword.mockResolvedValue({ match: false, needsRehash: false });
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow();
      expect(updateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          updateData: expect.objectContaining({
            failedLoginAttempts: 10,
            lockedUntil: expect.any(Date),
          }),
        })
      );
    });

    it("should NOT set lockedUntil before the 10th failure", async () => {
      getDocument.mockResolvedValue(makeUser({ failedLoginAttempts: 5 }));
      verifyPassword.mockResolvedValue({ match: false, needsRehash: false });
      await expect(loginWithEmailAndPassword(params)).rejects.toThrow();
      const updateCall = updateDocument.mock.calls[0][0];
      expect(updateCall.updateData.lockedUntil).toBeUndefined();
    });

    it("should reset failedLoginAttempts and lockedUntil on successful login", async () => {
      getDocument.mockResolvedValue(makeUser({ failedLoginAttempts: 5 }));
      await loginWithEmailAndPassword(params);
      expect(updateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          updateData: { failedLoginAttempts: 0, lockedUntil: null },
        })
      );
    });

    it("should NOT call the reset update when failedLoginAttempts is already 0", async () => {
      getDocument.mockResolvedValue(makeUser({ failedLoginAttempts: 0, lockedUntil: null }));
      await loginWithEmailAndPassword(params);
      const resetCall = updateDocument.mock.calls.find(
        (call) => call[0].updateData?.failedLoginAttempts === 0
      );
      expect(resetCall).toBeUndefined();
    });

    // password rehash migration

    it("should trigger password rehash when needsRehash is true", async () => {
      verifyPassword.mockResolvedValue({ match: true, needsRehash: true });
      await loginWithEmailAndPassword(params);
      expect(hashPassword).toHaveBeenCalled();
      expect(updateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          updateData: expect.objectContaining({ password: "$2b$12$hashed" }),
        })
      );
    });
  });

  // ── registerWithEmailAndPassword ──────────────────────────────────────────

  describe("registerWithEmailAndPassword", () => {
    const regParams = {
      userId: "user1",
      projectCode: "testproj",
      email: "new@example.com",
      password: "Password1!",
    };

    beforeEach(() => {
      // getDocument is called by the internal loginWithEmailAndPassword after registration
      getDocument.mockResolvedValue(
        makeUser({ email: "new@example.com", emailVerified: false })
      );
      verifyPassword.mockResolvedValue({ match: true, needsRehash: false });
    });

    it("should hash the password before storing", async () => {
      await registerWithEmailAndPassword(regParams);
      expect(hashPassword).toHaveBeenCalledWith("Password1!");
    });

    it("should throw when email is already registered", async () => {
      getUserDB.mockResolvedValue(
        makeMockDb({ findOne: jest.fn().mockResolvedValue({ email: "new@example.com" }) })
      );
      await expect(registerWithEmailAndPassword(regParams)).rejects.toThrow(
        "This email is already registered!"
      );
    });

    it("should return user token on successful registration", async () => {
      const user = await registerWithEmailAndPassword(regParams);
      expect(user.token).toBe("mock-jwt-token");
    });
  });

  // ── loginWithToken ────────────────────────────────────────────────────────

  describe("loginWithToken", () => {
    it("should return user on valid token", async () => {
      verifyToken.mockReturnValue({ userId: "user-id-123", project: "testproj" });
      getDocument.mockResolvedValue(makeUser());
      const user = await loginWithToken("user1", "testproj", "valid-token");
      expect(user.uid).toBe("user-id-123");
      expect(user.token).toBe("valid-token");
    });

    it("should strip sensitive fields from token login response", async () => {
      verifyToken.mockReturnValue({ userId: "user-id-123", project: "testproj" });
      getDocument.mockResolvedValue(makeUser({ password: "$2b$12$x", createdAt: new Date() }));
      const user = await loginWithToken("user1", "testproj", "valid-token");
      expect(user._id).toBeUndefined();
      expect(user.password).toBeUndefined();
      expect(user.isActive).toBeUndefined();
    });

    it("should throw 'User not found!' when user does not exist", async () => {
      verifyToken.mockReturnValue({ userId: "nonexistent", project: "testproj" });
      getDocument.mockResolvedValue(null);
      await expect(loginWithToken("user1", "testproj", "valid-token")).rejects.toThrow(
        "User not found!"
      );
    });
  });

  // ── anonymousLogin ────────────────────────────────────────────────────────

  describe("anonymousLogin", () => {
    it("should create an anonymous user and return token and uid", async () => {
      const user = await anonymousLogin("user1", "testproj", { name: "Guest" });
      expect(user.token).toBe("mock-jwt-token");
      expect(user.uid).toBe("new-user-id");
    });

    it("should use empty string for name when not provided", async () => {
      const db = makeMockDb();
      getUserDB.mockResolvedValue(db);
      await anonymousLogin("user1", "testproj", {});
      const insertArgs = db.collection().insertOne.mock.calls[0][0];
      expect(insertArgs.name).toBe("");
    });
  });

  // ── changePassword ────────────────────────────────────────────────────────

  describe("changePassword", () => {
    const cpParams = {
      userId: "user1",
      projectCode: "testproj",
      accountId: "user-id",
      oldPassword: "OldPass1!",
      newPassword: "NewPass1!",
    };

    it("should update password when old password is correct", async () => {
      getDocument.mockResolvedValue({ _id: "user-id", password: "$2b$12$old" });
      verifyPassword.mockResolvedValue({ match: true, needsRehash: false });
      const result = await changePassword(cpParams);
      expect(result.modifiedCount).toBe(1);
    });

    it("should throw 'Old password is incorrect!' on wrong old password", async () => {
      getDocument.mockResolvedValue({ _id: "user-id", password: "$2b$12$old" });
      verifyPassword.mockResolvedValue({ match: false, needsRehash: false });
      await expect(changePassword(cpParams)).rejects.toThrow("Old password is incorrect!");
    });

    it("should throw when account does not exist", async () => {
      getDocument.mockResolvedValue(null);
      await expect(changePassword(cpParams)).rejects.toThrow("Accounts doesn't exist!");
    });

    it("should hash the new password before storing", async () => {
      getDocument.mockResolvedValue({ _id: "user-id", password: "$2b$12$old" });
      verifyPassword.mockResolvedValue({ match: true, needsRehash: false });
      await changePassword(cpParams);
      expect(hashPassword).toHaveBeenCalledWith("NewPass1!");
    });
  });

  // ── sendResetPasswordEmail ────────────────────────────────────────────────

  describe("sendResetPasswordEmail", () => {
    beforeEach(() => {
      getDocument.mockResolvedValue({ _id: { toString: () => "user-id" }, email: "test@example.com" });
    });

    it("should clear the existing resetPasswordToken before generating a new one", async () => {
      await sendResetPasswordEmail({
        project: mockProject,
        email: "test@example.com",
        baseUrl: "http://localhost/reset-password?token=",
      });
      // First updateDocument call must null out the old token
      const firstCall = updateDocument.mock.calls[0];
      expect(firstCall[0].updateData).toEqual({ resetPasswordToken: null });
    });

    it("should store the new token after clearing the old one", async () => {
      generateVerificationToken
        .mockReturnValueOnce("link-token")   // for the email link
        .mockReturnValueOnce("action-token"); // for the DB storage
      await sendResetPasswordEmail({
        project: mockProject,
        email: "test@example.com",
        baseUrl: "http://localhost/reset-password?token=",
      });
      // Second updateDocument call stores the new action token
      const secondCall = updateDocument.mock.calls[1];
      expect(secondCall[0].updateData).toEqual({ resetPasswordToken: "action-token" });
    });

    it("should return true on success", async () => {
      const result = await sendResetPasswordEmail({
        project: mockProject,
        email: "test@example.com",
        baseUrl: "http://localhost/reset-password?token=",
      });
      expect(result).toBe(true);
    });

    it("should return false silently when account is not found", async () => {
      getDocument.mockResolvedValue(null);
      const result = await sendResetPasswordEmail({
        project: mockProject,
        email: "notfound@example.com",
        baseUrl: "http://localhost/reset-password?token=",
      });
      expect(result).toBe(false);
    });
  });

  // ── sendVerifyEmail ───────────────────────────────────────────────────────

  describe("sendVerifyEmail", () => {
    it("should throw when account is not found", async () => {
      getDocument.mockResolvedValue(null);
      await expect(
        sendVerifyEmail({ project: mockProject, email: "notfound@example.com", baseUrl: "http://localhost/verify?token=" })
      ).rejects.toThrow("Your Account wasn't found!");
    });

    it("should throw when email is already verified", async () => {
      getDocument.mockResolvedValue({ email: "test@example.com", emailVerified: true });
      await expect(
        sendVerifyEmail({ project: mockProject, email: "test@example.com", baseUrl: "http://localhost/verify?token=" })
      ).rejects.toThrow("Email is already verified!");
    });

    it("should return true on success", async () => {
      getDocument.mockResolvedValue({
        _id: { toString: () => "user-id" },
        email: "test@example.com",
        emailVerified: false,
      });
      const result = await sendVerifyEmail({
        project: mockProject,
        email: "test@example.com",
        baseUrl: "http://localhost/verify?token=",
      });
      expect(result).toBe(true);
    });
  });
});
