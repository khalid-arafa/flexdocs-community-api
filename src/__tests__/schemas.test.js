const {
  email,
  strongPassword,
  objectIdString,
  projectCode,
  collectionName,
  systemLoginSchema,
  systemRegisterSchema,
  systemProfileUpdateSchema,
  createProjectSchema,
  createCredentialSchema,
  dbRegisterSchema,
  dbLoginSchema,
  dbTokenLoginSchema,
  dbAnonymousLoginSchema,
  dbChangePasswordSchema,
  queryDocumentsSchema,
  listCollectionsSchema,
  createCollectionSchema,
  updateManySchema,
  deleteManySchema,
  createBucketSchema,
  updateBucketSchema,
  searchStorageSchema,
  adminListAccountsSchema,
  adminAddAccountSchema,
} = require("../utils/schemas");

// Helper to check parse success/failure
const ok = (schema, data) => schema.safeParse(data).success;
const fail = (schema, data) => !schema.safeParse(data).success;

describe("schemas.js", () => {
  // ===== Field-level schemas =====

  describe("email", () => {
    it('should accept valid email "test@example.com"', () => {
      expect(ok(email, "test@example.com")).toBe(true);
    });

    it("should lowercase email", () => {
      const result = email.safeParse("Test@Example.COM");
      expect(result.success).toBe(true);
      expect(result.data).toBe("test@example.com");
    });

    it('should reject "not-an-email"', () => {
      expect(fail(email, "not-an-email")).toBe(true);
    });

    it("should reject empty string", () => {
      expect(fail(email, "")).toBe(true);
    });
  });

  describe("strongPassword", () => {
    it('should accept "Passw0rd!"', () => {
      expect(ok(strongPassword, "Passw0rd!")).toBe(true);
    });

    it('should reject "weak"', () => {
      expect(fail(strongPassword, "weak")).toBe(true);
    });

    it("should reject missing uppercase", () => {
      expect(fail(strongPassword, "passw0rd!")).toBe(true);
    });

    it("should reject missing digit", () => {
      expect(fail(strongPassword, "Password!")).toBe(true);
    });

    it("should reject missing symbol", () => {
      expect(fail(strongPassword, "Passw0rdd")).toBe(true);
    });

    it("should reject string > 128 chars", () => {
      const long = "A1!" + "a".repeat(130);
      expect(fail(strongPassword, long)).toBe(true);
    });
  });

  describe("objectIdString", () => {
    it("should accept valid 24-char hex", () => {
      expect(ok(objectIdString, "507f1f77bcf86cd799439011")).toBe(true);
    });

    it('should reject "not-an-id"', () => {
      expect(fail(objectIdString, "not-an-id")).toBe(true);
    });

    it("should reject 23-char hex", () => {
      expect(fail(objectIdString, "507f1f77bcf86cd79943901")).toBe(true);
    });

    it("should accept uppercase hex", () => {
      expect(ok(objectIdString, "507F1F77BCF86CD799439011")).toBe(true);
    });
  });

  describe("projectCode", () => {
    it('should accept "myProject"', () => {
      expect(ok(projectCode, "myProject")).toBe(true);
    });

    it('should accept "my-project_1"', () => {
      expect(ok(projectCode, "my-project_1")).toBe(true);
    });

    it("should reject starting with number", () => {
      expect(fail(projectCode, "1startsWithNumber")).toBe(true);
    });

    it("should reject empty string", () => {
      expect(fail(projectCode, "")).toBe(true);
    });
  });

  describe("collectionName", () => {
    it('should accept "users"', () => {
      expect(ok(collectionName, "users")).toBe(true);
    });

    it('should accept "user_data"', () => {
      expect(ok(collectionName, "user_data")).toBe(true);
    });

    it('should reject reserved name "_users"', () => {
      expect(fail(collectionName, "_users")).toBe(true);
    });

    it('should reject reserved name "admin"', () => {
      expect(fail(collectionName, "admin")).toBe(true);
    });

    it('should reject reserved name "_system"', () => {
      expect(fail(collectionName, "_system")).toBe(true);
    });

    it("should reject name starting with number", () => {
      expect(fail(collectionName, "1abc")).toBe(true);
    });

    it("should reject name with hyphens", () => {
      expect(fail(collectionName, "my-col")).toBe(true);
    });

    it("should reject empty string", () => {
      expect(fail(collectionName, "")).toBe(true);
    });

    it("should reject name > 64 chars", () => {
      expect(fail(collectionName, "a".repeat(65))).toBe(true);
    });
  });

  // ===== Route schemas =====

  describe("systemLoginSchema", () => {
    it("should accept valid login", () => {
      expect(ok(systemLoginSchema, { email: "a@b.com", password: "pass" })).toBe(true);
    });

    it("should reject missing email", () => {
      expect(fail(systemLoginSchema, { password: "pass" })).toBe(true);
    });

    it("should reject missing password", () => {
      expect(fail(systemLoginSchema, { email: "a@b.com" })).toBe(true);
    });
  });

  describe("systemRegisterSchema", () => {
    it("should accept valid registration", () => {
      expect(ok(systemRegisterSchema, { name: "John", email: "a@b.com", password: "Passw0rd!" })).toBe(true);
    });

    it("should reject weak password", () => {
      expect(fail(systemRegisterSchema, { name: "John", email: "a@b.com", password: "weak" })).toBe(true);
    });

    it("should reject missing name", () => {
      expect(fail(systemRegisterSchema, { email: "a@b.com", password: "Passw0rd!" })).toBe(true);
    });
  });

  describe("systemProfileUpdateSchema", () => {
    it("should accept empty object (all optional)", () => {
      expect(ok(systemProfileUpdateSchema, {})).toBe(true);
    });

    it("should accept partial update", () => {
      expect(ok(systemProfileUpdateSchema, { name: "New Name" })).toBe(true);
    });

    it("should require strong password if password provided", () => {
      expect(fail(systemProfileUpdateSchema, { password: "weak" })).toBe(true);
    });
  });

  describe("createProjectSchema", () => {
    it("should accept valid project", () => {
      expect(ok(createProjectSchema, { name: "My Project", code: "myProject" })).toBe(true);
    });

    it("should accept optional fields", () => {
      expect(ok(createProjectSchema, { name: "P", code: "p", description: "Desc", isPublic: true })).toBe(true);
    });

    it("should reject missing name", () => {
      expect(fail(createProjectSchema, { code: "p" })).toBe(true);
    });

    it("should reject invalid code format", () => {
      expect(fail(createProjectSchema, { name: "P", code: "1bad" })).toBe(true);
    });
  });

  describe("createCredentialSchema", () => {
    it("should accept { name }", () => {
      expect(ok(createCredentialSchema, { name: "API Key" })).toBe(true);
    });

    it("should reject missing name", () => {
      expect(fail(createCredentialSchema, {})).toBe(true);
    });
  });

  describe("dbRegisterSchema", () => {
    it("should accept { email, password }", () => {
      expect(ok(dbRegisterSchema, { email: "a@b.com", password: "pass" })).toBe(true);
    });

    it("should accept optional name and avatar", () => {
      expect(ok(dbRegisterSchema, { email: "a@b.com", password: "p", name: "J", avatar: "u" })).toBe(true);
    });

    it("should reject missing email", () => {
      expect(fail(dbRegisterSchema, { password: "pass" })).toBe(true);
    });

    // Privilege-escalation regression: self-registration is anonymous, and the
    // parsed body is what reaches the account document, so a client-supplied
    // `roles` array must never survive validation.
    it("should strip client-supplied roles", () => {
      const parsed = dbRegisterSchema.safeParse({
        email: "a@b.com",
        password: "pass",
        roles: ["admin", "superadmin"],
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data.roles).toBeUndefined();
      expect(Object.keys(parsed.data)).not.toContain("roles");
    });

    it("should still allow roles on the admin-only account schema", () => {
      const parsed = adminAddAccountSchema.safeParse({
        name: "Admin",
        email: "a@b.com",
        password: "pass",
        roles: ["admin"],
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data.roles).toEqual(["admin"]);
    });
  });

  describe("dbLoginSchema", () => {
    it("should accept valid login", () => {
      expect(ok(dbLoginSchema, { email: "a@b.com", password: "pass" })).toBe(true);
    });

    it("should reject missing fields", () => {
      expect(fail(dbLoginSchema, {})).toBe(true);
    });
  });

  describe("dbTokenLoginSchema", () => {
    it("should accept { token }", () => {
      expect(ok(dbTokenLoginSchema, { token: "some-jwt-token" })).toBe(true);
    });

    it("should reject empty token", () => {
      expect(fail(dbTokenLoginSchema, { token: "" })).toBe(true);
    });
  });

  describe("dbChangePasswordSchema", () => {
    it("should accept valid passwords", () => {
      expect(ok(dbChangePasswordSchema, { oldPassword: "old", newPassword: "Passw0rd!" })).toBe(true);
    });

    it("should reject weak newPassword", () => {
      expect(fail(dbChangePasswordSchema, { oldPassword: "old", newPassword: "weak" })).toBe(true);
    });
  });

  describe("queryDocumentsSchema", () => {
    it("should accept empty object (all optional)", () => {
      expect(ok(queryDocumentsSchema, {})).toBe(true);
    });

    it("should accept { limit: 10, page: 1 }", () => {
      expect(ok(queryDocumentsSchema, { limit: 10, page: 1 })).toBe(true);
    });

    it("should reject limit > 500", () => {
      expect(fail(queryDocumentsSchema, { limit: 501 })).toBe(true);
    });

    it("should reject limit < 1", () => {
      expect(fail(queryDocumentsSchema, { limit: 0 })).toBe(true);
    });

    it("should reject negative skip", () => {
      expect(fail(queryDocumentsSchema, { skip: -1 })).toBe(true);
    });

    it("should accept sort with 1 and -1", () => {
      expect(ok(queryDocumentsSchema, { sort: { name: 1, createdAt: -1 } })).toBe(true);
    });
  });

  describe("createCollectionSchema", () => {
    it('should accept { name: "validCollection" }', () => {
      expect(ok(createCollectionSchema, { name: "validCollection" })).toBe(true);
    });

    it('should reject { name: "_users" } (reserved)', () => {
      expect(fail(createCollectionSchema, { name: "_users" })).toBe(true);
    });

    it("should reject missing name", () => {
      expect(fail(createCollectionSchema, {})).toBe(true);
    });
  });

  describe("updateManySchema", () => {
    it("should accept { filter, newData }", () => {
      expect(ok(updateManySchema, { filter: { age: 5 }, newData: { age: 6 } })).toBe(true);
    });

    it("should reject missing filter", () => {
      expect(fail(updateManySchema, { newData: { x: 1 } })).toBe(true);
    });

    it("should reject missing newData", () => {
      expect(fail(updateManySchema, { filter: { x: 1 } })).toBe(true);
    });
  });

  describe("deleteManySchema", () => {
    it("should accept { filter }", () => {
      expect(ok(deleteManySchema, { filter: { status: "old" } })).toBe(true);
    });

    it("should accept empty object (filter optional)", () => {
      expect(ok(deleteManySchema, {})).toBe(true);
    });
  });

  describe("createBucketSchema", () => {
    it('should accept { name: "my-bucket" }', () => {
      expect(ok(createBucketSchema, { name: "my-bucket" })).toBe(true);
    });

    it("should reject missing name", () => {
      expect(fail(createBucketSchema, {})).toBe(true);
    });

    it("should accept optional parentId as null", () => {
      expect(ok(createBucketSchema, { name: "b", parentId: null })).toBe(true);
    });
  });

  describe("updateBucketSchema", () => {
    it("should accept partial update", () => {
      expect(ok(updateBucketSchema, { name: "new-name" })).toBe(true);
    });

    it("should accept empty object (all optional)", () => {
      expect(ok(updateBucketSchema, {})).toBe(true);
    });
  });

  describe("searchStorageSchema", () => {
    it('should accept { searchTerm: "photo" }', () => {
      expect(ok(searchStorageSchema, { searchTerm: "photo" })).toBe(true);
    });

    it("should reject missing searchTerm", () => {
      expect(fail(searchStorageSchema, {})).toBe(true);
    });

    it("should reject searchTerm > 200 chars", () => {
      expect(fail(searchStorageSchema, { searchTerm: "a".repeat(201) })).toBe(true);
    });

    it("should reject ipp > 100", () => {
      expect(fail(searchStorageSchema, { searchTerm: "x", ipp: 101 })).toBe(true);
    });
  });

  describe("adminListAccountsSchema", () => {
    it("should accept empty object", () => {
      expect(ok(adminListAccountsSchema, {})).toBe(true);
    });

    it("should accept query and sort", () => {
      expect(ok(adminListAccountsSchema, { query: { role: "admin" }, sort: { name: 1 } })).toBe(true);
    });
  });

  describe("adminAddAccountSchema", () => {
    it("should accept valid account", () => {
      expect(ok(adminAddAccountSchema, { name: "Admin", email: "a@b.com", password: "pass" })).toBe(true);
    });

    it("should reject missing email", () => {
      expect(fail(adminAddAccountSchema, { name: "Admin", password: "pass" })).toBe(true);
    });
  });
});
