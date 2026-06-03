jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const {
  isValidEmail,
  isValidPhone,
  isStrongPassword,
  dbRulesValidator,
  validateDbRulesStructure,
  validateAuthRules,
} = require("../utils/validators");

describe("validators.js", () => {
  describe("isValidEmail", () => {
    it("should return true for standard email", () => {
      expect(isValidEmail("user@example.com")).toBe(true);
    });

    it("should return true for email with subdomain", () => {
      expect(isValidEmail("user@mail.example.com")).toBe(true);
    });

    it("should return false for missing @", () => {
      expect(isValidEmail("userexample.com")).toBe(false);
    });

    it("should return false for missing domain", () => {
      expect(isValidEmail("user@")).toBe(false);
    });

    it("should return false for spaces", () => {
      expect(isValidEmail("us er@example.com")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isValidEmail("")).toBe(false);
    });
  });

  describe("isValidPhone", () => {
    it('should return true for "+1234567890"', () => {
      expect(isValidPhone("+1234567890")).toBe(true);
    });

    it("should return false for alphabetic string", () => {
      expect(isValidPhone("abc")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isValidPhone("")).toBe(false);
    });
  });

  describe("isStrongPassword", () => {
    it('should return true for "Passw0rd!"', () => {
      expect(isStrongPassword("Passw0rd!")).toBe(true);
    });

    it("should return false for all lowercase no symbol", () => {
      expect(isStrongPassword("password")).toBe(false);
    });

    it("should return false for no lowercase", () => {
      expect(isStrongPassword("PASSWORD1!")).toBe(false);
    });

    it("should return false for no symbol", () => {
      expect(isStrongPassword("Passw0rd")).toBe(false);
    });

    it("should return false for too short", () => {
      expect(isStrongPassword("Pa1!")).toBe(false);
    });

    it("should return true for exactly 8 chars meeting all criteria", () => {
      expect(isStrongPassword("A1b!cdef")).toBe(true);
    });

    it("should return false for empty string", () => {
      expect(isStrongPassword("")).toBe(false);
    });
  });

  describe("validateDbRulesStructure", () => {
    it("should return valid for null input", () => {
      expect(validateDbRulesStructure(null)).toEqual({ valid: true, errors: [] });
    });

    it("should return valid for undefined input", () => {
      expect(validateDbRulesStructure(undefined)).toEqual({ valid: true, errors: [] });
    });

    it("should return invalid for string input", () => {
      const result = validateDbRulesStructure("not an object");
      expect(result.valid).toBe(false);
    });

    it("should return invalid for array input", () => {
      const result = validateDbRulesStructure([]);
      expect(result.valid).toBe(false);
    });

    it("should accept valid path with boolean rule", () => {
      const result = validateDbRulesStructure({ "/users": true });
      expect(result.valid).toBe(true);
    });

    it("should accept valid path with [id] and boolean", () => {
      const result = validateDbRulesStructure({ "/users/[id]": true });
      expect(result.valid).toBe(true);
    });

    it("should accept path with JEXL string expression", () => {
      const result = validateDbRulesStructure({ "/users": 'user.id == "admin"' });
      expect(result.valid).toBe(true);
    });

    it("should reject path without leading slash", () => {
      const result = validateDbRulesStructure({ users: true });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Invalid rule path");
    });

    it("should reject path with too many segments", () => {
      const result = validateDbRulesStructure({ "/users/[id]/extra": true });
      expect(result.valid).toBe(false);
    });

    it("should accept action object with valid actions", () => {
      const result = validateDbRulesStructure({
        "/posts": { read: true, add: false, update: true, delete: false },
      });
      expect(result.valid).toBe(true);
    });

    it("should reject unknown action in action object", () => {
      const result = validateDbRulesStructure({
        "/posts": { write: true },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Unknown action "write"');
    });

    it("should reject non-boolean non-string rule value in action", () => {
      const result = validateDbRulesStructure({
        "/posts": { read: 42 },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be boolean or JEXL string");
    });

    it("should validate JEXL expressions compile without error", () => {
      const result = validateDbRulesStructure({
        "/posts": { read: 'user.role == "admin"' },
      });
      expect(result.valid).toBe(true);
    });

    it("should reject invalid JEXL expression", () => {
      const result = validateDbRulesStructure({
        "/posts": { read: "user.role ==" },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Invalid JEXL expression");
    });

    it("should return multiple errors for multiple problems", () => {
      const result = validateDbRulesStructure({
        badpath: true,
        "/ok": { write: true },
      });
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("should accept empty rules object", () => {
      const result = validateDbRulesStructure({});
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe("validateAuthRules", () => {
    it("should return valid for null input", () => {
      expect(validateAuthRules(null)).toEqual({ valid: true, errors: [] });
    });

    it("should return valid for undefined input", () => {
      expect(validateAuthRules(undefined)).toEqual({ valid: true, errors: [] });
    });

    it("should return invalid for non-object input", () => {
      const result = validateAuthRules("string");
      expect(result.valid).toBe(false);
    });

    it("should return invalid for array input", () => {
      const result = validateAuthRules([]);
      expect(result.valid).toBe(false);
    });

    it("should accept valid keys with boolean values", () => {
      const result = validateAuthRules({
        allowEmailRegistration: true,
        requireStrongPassword: false,
      });
      expect(result.valid).toBe(true);
    });

    it("should reject unknown key", () => {
      const result = validateAuthRules({ unknownRule: true });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Unknown auth rule: "unknownRule"');
    });

    it("should reject non-boolean value for known key", () => {
      const result = validateAuthRules({ allowEmailRegistration: "yes" });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("must be a boolean");
    });

    it("should accept a subset of valid keys", () => {
      const result = validateAuthRules({ allowPasswordReset: true });
      expect(result.valid).toBe(true);
    });

    it("should return multiple errors for multiple problems", () => {
      const result = validateAuthRules({ unknownKey: "not-bool", otherKey: 42 });
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("dbRulesValidator", () => {
    it("should return true when no matching path found (permissive default)", async () => {
      const result = await dbRulesValidator({
        path: "/nonexistent",
        action: "read",
        rules: {},
        context: { user: null },
      });
      expect(result).toBe(true);
    });

    it("should return the boolean when action is a top-level key with value true", async () => {
      const result = await dbRulesValidator({
        path: "/users",
        action: "read",
        rules: { read: true },
        context: {},
      });
      expect(result).toBe(true);
    });

    it("should return false when action is a top-level key with value false", async () => {
      const result = await dbRulesValidator({
        path: "/users",
        action: "read",
        rules: { read: false },
        context: {},
      });
      expect(result).toBe(false);
    });

    it("should return true when path matches and action is true", async () => {
      const result = await dbRulesValidator({
        path: "/posts",
        action: "read",
        rules: { "/posts": { read: true } },
        context: {},
      });
      expect(result).toBe(true);
    });

    it("should evaluate JEXL expression and return result", async () => {
      const result = await dbRulesValidator({
        path: "/posts",
        action: "read",
        rules: { "/posts": { read: "user.role == 'admin'" } },
        context: { user: { role: "admin" } },
      });
      expect(result).toBe(true);
    });

    it("should return false when JEXL expression evaluates to false", async () => {
      const result = await dbRulesValidator({
        path: "/posts",
        action: "read",
        rules: { "/posts": { read: "user.role == 'admin'" } },
        context: { user: { role: "viewer" } },
      });
      expect(result).toBe(false);
    });

    it("should return true when path matches but action is undefined", async () => {
      const result = await dbRulesValidator({
        path: "/posts",
        action: "delete",
        rules: { "/posts": { read: true } },
        context: {},
      });
      expect(result).toBe(true);
    });
  });
});
