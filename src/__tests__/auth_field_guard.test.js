const { authCollectionName } = require("../constants");
const { stripProtectedAuthFields, PROTECTED_AUTH_FIELDS } = require("../utils/auth_field_guard");

describe("stripProtectedAuthFields", () => {
  it("removes every protected field when the target is the auth collection", () => {
    const data = {
      name: "Ada",
      lockedUntil: new Date(),
      failedLoginAttempts: 0,
      tokenVersion: 5,
      resetPasswordToken: "abc",
    };
    const result = stripProtectedAuthFields(authCollectionName, data);
    for (const field of PROTECTED_AUTH_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }
    expect(result.name).toBe("Ada");
  });

  it("leaves data untouched for any other collection", () => {
    const data = { lockedUntil: "x", tokenVersion: 1, name: "widget" };
    const result = stripProtectedAuthFields("products", data);
    expect(result).toEqual(data);
  });

  it("does not mutate the original object", () => {
    const data = { name: "Ada", tokenVersion: 5 };
    stripProtectedAuthFields(authCollectionName, data);
    expect(data.tokenVersion).toBe(5);
  });

  it("passes through null/undefined data unchanged", () => {
    expect(stripProtectedAuthFields(authCollectionName, null)).toBeNull();
    expect(stripProtectedAuthFields(authCollectionName, undefined)).toBeUndefined();
  });
});
