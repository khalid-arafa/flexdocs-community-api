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

// Email/SMTP settings (used by the setup wizard and the settings API).
// Secret fields are optional; an empty value or the mask keeps the stored one.
// Provider-specific requirements are enforced in config_service.saveEmailConfig
// so callers get clear, contextual errors.
const emailSettingsSchema = z.object({
  provider: z.enum(["none", "smtp", "resend"]).optional(),
  smtp: z
    .object({
      host: z.string().max(255).optional(),
      port: z.coerce.number().int().min(1).max(65535).optional(),
      user: z.string().max(255).optional(),
      pass: z.string().max(1024).optional(),
    })
    .optional(),
  resendApiKey: z.string().max(1024).optional(),
  from: z
    .object({
      name: z.string().max(100).optional(),
      email: z.union([z.string().email(), z.literal("")]).optional(),
    })
    .optional(),
  supportEmail: z.union([z.string().email(), z.literal("")]).optional(),
});

// First-run setup wizard: creates the single admin account. Token is checked
// in the route handler (not here) so we can return a clear 403 on mismatch.
// Optional `email` lets the operator configure email during first-run setup.
const setupSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100).trim(),
    email,
    password: strongPassword,
    confirmPassword: z.string().min(1, "Password confirmation is required").max(128),
    token: z.string().min(1).max(256).optional(),
    emailConfig: emailSettingsSchema.optional(),
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

// Public self-registration. `roles` is deliberately absent: this endpoint is
// reachable anonymously, and roles feed the `user` object that DB/storage rules
// authorize against, so accepting them here would let a caller grant itself any
// role. Roles are assignable only via the admin-guarded account endpoints
// (adminAddAccountSchema below, and PUT /auth/accounts/:id).
const dbRegisterSchema = z.object({
  email,
  password,
  name: z.string().max(100).trim().optional(),
  avatar: z.string().max(500).optional(),
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
  emailSettingsSchema,
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
