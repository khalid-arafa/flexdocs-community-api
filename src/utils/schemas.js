const { z } = require("zod");
const { reservedCollectionNames, authCollectionName } = require("../constants");

// ===== Reusable field schemas =====

const email = z.string().email("Invalid email format").max(255).trim().toLowerCase();

const password = z.string().min(1, "Password is required").max(128);

const strongPassword = z
  .string()
  .min(8)
  .max(128)
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/,
    "Password must be 8+ chars with upper, lower, number & symbol",
  );

const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid ObjectId");

const projectCode = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    "Code must start with a letter and contain only alphanumeric, hyphen, underscore",
  );

const allReserved = [...reservedCollectionNames, authCollectionName];

const collectionName = z
  .string()
  .min(1, "Collection name is required")
  .max(64)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]*$/,
    "Must start with a letter, alphanumeric and underscore only",
  )
  .refine((val) => !allReserved.includes(val), {
    message: "This is a reserved collection name",
  });

// ===== System auth schemas =====

const systemLoginSchema = z.object({
  email,
  password,
});

const systemRegisterSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  email,
  password: strongPassword,
});

// First-run setup wizard: creates the single admin account. Token is checked
// in the route handler (not here) so we can return a clear 403 on mismatch.
const setupSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100).trim(),
    email,
    password: strongPassword,
    confirmPassword: z.string().min(1, "Password confirmation is required").max(128),
    token: z.string().min(1).max(256).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

const systemProfileUpdateSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  email: email.optional(),
  phone: z.string().max(30).optional(),
  password: strongPassword.optional(),
  oldPassword: z.string().max(128).optional(),
});

// ===== Project schemas =====

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  code: projectCode,
  description: z.string().max(500).optional(),
  isPublic: z.boolean().optional(),
});

const createCredentialSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  description: z.string().max(500).optional(),
});

// ===== Project auth (DB user auth) schemas =====

const dbRegisterSchema = z.object({
  email,
  password,
  name: z.string().max(100).trim().optional(),
  avatar: z.string().max(500).optional(),
  roles: z.array(z.string().max(50)).optional(),
});

const dbLoginSchema = z.object({
  email,
  password,
});

const dbTokenLoginSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

const dbAnonymousLoginSchema = z
  .object({
    name: z.string().max(100).trim().optional(),
    avatar: z.string().max(500).optional(),
  })
  .passthrough();

const dbChangePasswordSchema = z.object({
  oldPassword: z.string().min(1, "Old password is required").max(128),
  newPassword: strongPassword,
});

// ===== DB route schemas =====

const queryDocumentsSchema = z.object({
  query: z.record(z.string(), z.unknown()).optional(),
  sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
  select: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  page: z.number().int().min(1).optional(),
  skip: z.number().int().min(0).optional(),
});

const listCollectionsSchema = z.object({
  where: z.record(z.string(), z.unknown()).optional(),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const createCollectionSchema = z.object({
  name: collectionName,
});

const renameCollectionSchema = z.object({
  newName: collectionName,
});

const updateManySchema = z.object({
  filter: z.record(z.string(), z.unknown()),
  newData: z.record(z.string(), z.unknown()),
});

const deleteManySchema = z.object({
  filter: z.record(z.string(), z.unknown()).optional(),
});

// ===== Storage schemas =====

const createBucketSchema = z.object({
  name: z.string().min(1, "Bucket name is required").max(100).trim(),
  description: z.string().max(500).optional(),
  parentId: z.string().optional().nullable(),
});

const updateBucketSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).optional(),
});

const searchStorageSchema = z.object({
  bucketId: z.string().optional().nullable(),
  searchTerm: z.string().min(1, "Search term is required").max(200),
  page: z.number().int().min(1).optional(),
  ipp: z.number().int().min(1).max(100).optional(),
});

const updateFileSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  isPublic: z.boolean().optional(),
});

// ===== Admin account schemas =====

const adminListAccountsSchema = z.object({
  query: z.record(z.string(), z.unknown()).optional(),
  sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
  select: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  page: z.number().int().min(1).optional(),
});

const adminAddAccountSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  email,
  password,
  roles: z.array(z.string().max(50)).optional(),
  avatar: z.string().max(500).optional(),
});

module.exports = {
  // field-level
  collectionName,
  objectIdString,
  projectCode,
  email,
  strongPassword,
  // system
  systemLoginSchema,
  systemRegisterSchema,
  systemProfileUpdateSchema,
  setupSchema,
  // projects
  createProjectSchema,
  createCredentialSchema,
  // project auth
  dbRegisterSchema,
  dbLoginSchema,
  dbTokenLoginSchema,
  dbAnonymousLoginSchema,
  dbChangePasswordSchema,
  // db
  queryDocumentsSchema,
  listCollectionsSchema,
  createCollectionSchema,
  renameCollectionSchema,
  updateManySchema,
  deleteManySchema,
  // storage
  createBucketSchema,
  updateBucketSchema,
  searchStorageSchema,
  updateFileSchema,
  // admin
  adminListAccountsSchema,
  adminAddAccountSchema,
};
