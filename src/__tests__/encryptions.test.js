jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const { hashPassword, verifyPassword, getToken, verifyToken, encrypt, decrypt } = require("../utils/encryptions");

describe("encryptions.js", () => {
  describe("hashPassword", () => {
    it("should return a bcrypt hash string", async () => {
      const hash = await hashPassword("mypassword");
      expect(hash).toMatch(/^\$2[ab]\$/);
    });

    it("should produce different hashes for the same input (random salt)", async () => {
      const h1 = await hashPassword("same");
      const h2 = await hashPassword("same");
      expect(h1).not.toBe(h2);
    });
  });

  describe("verifyPassword", () => {
    it("should return match:true for correct bcrypt password", async () => {
      const hash = await hashPassword("correct");
      const result = await verifyPassword("correct", hash);
      expect(result).toEqual({ match: true, needsRehash: false });
    });

    it("should return match:false for wrong bcrypt password", async () => {
      const hash = await hashPassword("correct");
      const result = await verifyPassword("wrong", hash);
      expect(result).toEqual({ match: false, needsRehash: false });
    });

    it("should return match:true, needsRehash:true for correct legacy AES password", async () => {
      const encrypted = encrypt("legacypass");
      const result = await verifyPassword("legacypass", encrypted);
      expect(result).toEqual({ match: true, needsRehash: true });
    });

    it("should return match:false for wrong legacy AES password", async () => {
      const encrypted = encrypt("legacypass");
      const result = await verifyPassword("wrongpass", encrypted);
      expect(result).toEqual({ match: false, needsRehash: false });
    });

    it("should return match:false for corrupted hash", async () => {
      const result = await verifyPassword("test", "not-a-valid-hash");
      expect(result).toEqual({ match: false, needsRehash: false });
    });
  });

  describe("getToken", () => {
    it("should return a valid JWT string", () => {
      const token = getToken({ userId: "123" });
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3);
    });

    it("should sign with JWT_SECRET", () => {
      const token = getToken({ userId: "abc" });
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      expect(decoded.userId).toBe("abc");
    });

    it("should fail verification with wrong secret", () => {
      const token = getToken({ userId: "abc" });
      expect(() => jwt.verify(token, "wrong-secret")).toThrow();
    });

    it("should include the payload data in the token", () => {
      const token = getToken({ foo: "bar", num: 42 });
      const decoded = jwt.decode(token);
      expect(decoded.foo).toBe("bar");
      expect(decoded.num).toBe(42);
    });

    it("should respect custom expiresIn option", () => {
      const token = getToken({ id: 1 }, { expiresIn: "5s" });
      const decoded = jwt.decode(token);
      expect(decoded.exp - decoded.iat).toBe(5);
    });
  });

  describe("verifyToken", () => {
    it("should decode a valid token", () => {
      const token = getToken({ userId: "test123" });
      const decoded = verifyToken(token);
      expect(decoded).toBeTruthy();
      expect(decoded.userId).toBe("test123");
    });

    it("should return null for a tampered token", () => {
      const token = getToken({ userId: "x" });
      const tampered = token.slice(0, -5) + "XXXXX";
      expect(verifyToken(tampered)).toBeNull();
    });

    it("should return null for a token signed with different secret", () => {
      const token = jwt.sign({ userId: "x" }, "other-secret", { expiresIn: "1h" });
      expect(verifyToken(token)).toBeNull();
    });

    it("should flag an expired token as expired", () => {
      // verifyToken intentionally returns { expired: true } (not null) for
      // expired tokens — the auth middleware relies on this flag to respond
      // with a 401 "session expired" instead of a generic invalid-token error.
      const token = jwt.sign({ userId: "x" }, process.env.JWT_SECRET, { expiresIn: "0s" });
      expect(verifyToken(token)).toEqual({ expired: true });
    });
  });
});
