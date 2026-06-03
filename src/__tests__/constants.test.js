const constants = require("../constants");

describe("constants.js", () => {
  describe("reservedCollectionNames", () => {
    it("should be an array", () => {
      expect(Array.isArray(constants.reservedCollectionNames)).toBe(true);
    });

    it("should contain core reserved names", () => {
      const expected = ["admin", "_system", "_auth", "_config", "_projects", "_buckets", "_files", "_users"];
      for (const name of expected) {
        expect(constants.reservedCollectionNames).toContain(name);
      }
    });

    it("should include _users (authCollectionName)", () => {
      expect(constants.reservedCollectionNames).toContain(constants.authCollectionName);
    });
  });

  describe("system identifiers", () => {
    it("should have authCollectionName as _users", () => {
      expect(constants.authCollectionName).toBe("_users");
    });

    it("should have systemDatabaseName as _system", () => {
      expect(constants.systemDatabaseName).toBe("_system");
    });

    it("should have systemProjectCode as _system", () => {
      expect(constants.systemProjectCode).toBe("_system");
    });
  });

  describe("defaultAuthRules", () => {
    it("should be a plain object with 6 keys", () => {
      expect(typeof constants.defaultAuthRules).toBe("object");
      expect(Object.keys(constants.defaultAuthRules)).toHaveLength(6);
    });

    it("should have only boolean values", () => {
      for (const val of Object.values(constants.defaultAuthRules)) {
        expect(typeof val).toBe("boolean");
      }
    });

    it("should have expected defaults", () => {
      expect(constants.defaultAuthRules.allowEmailRegistration).toBe(true);
      expect(constants.defaultAuthRules.requireStrongPassword).toBe(false);
      expect(constants.defaultAuthRules.requireEmailVerification).toBe(false);
    });
  });

  describe("authCookieNames", () => {
    it("should have system, dbUser, legacy keys", () => {
      expect(constants.authCookieNames).toHaveProperty("system");
      expect(constants.authCookieNames).toHaveProperty("dbUser");
      expect(constants.authCookieNames).toHaveProperty("legacy");
    });

    it("should have correct values", () => {
      expect(constants.authCookieNames.system).toBe("flexdocs-auth-token");
      expect(constants.authCookieNames.dbUser).toBe("db-auth-token");
      expect(constants.authCookieNames.legacy).toBe("token");
    });
  });

  describe("tokenExpiry", () => {
    it("should have auth and verification keys", () => {
      expect(constants.tokenExpiry.auth).toBe("30d");
      expect(constants.tokenExpiry.verification).toBe("10m");
    });
  });

  describe("pagination", () => {
    it("should have correct defaults", () => {
      expect(constants.pagination.defaultPage).toBe(1);
      expect(constants.pagination.defaultLimit).toBe(20);
      expect(constants.pagination.maxLimit).toBe(500);
    });
  });

  describe("imageSizes", () => {
    it("should have correct pixel values", () => {
      expect(constants.imageSizes.small).toBe(300);
      expect(constants.imageSizes.medium).toBe(800);
      expect(constants.imageSizes.large).toBe(1200);
    });
  });

  describe("uploadLimits", () => {
    it("should have maxFileSize of 50MB", () => {
      expect(constants.uploadLimits.maxFileSize).toBe(50 * 1024 * 1024);
    });

    it("should have maxFileNameLength of 255", () => {
      expect(constants.uploadLimits.maxFileNameLength).toBe(255);
    });

    it("should have blockedExtensions as a Set", () => {
      expect(constants.uploadLimits.blockedExtensions).toBeInstanceOf(Set);
      expect(constants.uploadLimits.blockedExtensions.has("exe")).toBe(true);
      expect(constants.uploadLimits.blockedExtensions.has("bat")).toBe(true);
      expect(constants.uploadLimits.blockedExtensions.has("jpg")).toBe(false);
    });
  });
});
