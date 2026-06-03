# RT_DB API Backend Documentation

> **Purpose**: This document is the definitive reference for AI agents maintaining the JavaScript client library that serves tenants of this project. When the backend changes, consult this document to understand every endpoint, socket event, authentication mechanism, data shape, and convention so the client library can be updated accurately.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Base URL & Route Prefixes](#2-base-url--route-prefixes)
3. [Authentication & Authorization](#3-authentication--authorization)
4. [Headers & Cookies](#4-headers--cookies)
5. [Error Response Format](#5-error-response-format)
6. [Pagination Conventions](#6-pagination-conventions)
7. [Auth Endpoints](#7-auth-endpoints)
8. [Database Endpoints](#8-database-endpoints)
9. [Storage Endpoints](#9-storage-endpoints)
10. [Socket.IO Real-Time API](#10-socketio-real-time-api)
11. [Database Rules (JEXL)](#11-database-rules-jexl)
12. [Auth Rules](#12-auth-rules)
13. [Query Format & Special Operators](#13-query-format--special-operators)
14. [Validation Schemas (Zod)](#14-validation-schemas-zod)
15. [Rate Limiting](#15-rate-limiting)
16. [CSRF Protection](#16-csrf-protection)
17. [File Upload Protocol (Socket.IO)](#17-file-upload-protocol-socketio)
18. [Data Models & Shapes](#18-data-models--shapes)
19. [Constants & Limits](#19-constants--limits)
20. [Multi-Tenancy Model](#20-multi-tenancy-model)

---

## 1. Architecture Overview

RT_DB is a multi-tenant real-time database backend built on:

- **Runtime**: Node.js + Express
- **Database**: MongoDB (one database per project/tenant)
- **Real-time**: Socket.IO
- **Auth**: JWT (jsonwebtoken) + bcrypt password hashing
- **Rules engine**: JEXL expressions for access control
- **File storage**: Local filesystem with image resizing (sharp)
- **Email**: Resend API or SMTP (Nodemailer)

### Request lifecycle

```
Client Request
  -> requestId middleware (adds X-Request-Id)
  -> dynamicCors (CORS with project-specific origins)
  -> helmet (security headers)
  -> cookieParser
  -> validateJsonBody (1MB limit)
  -> apiLimiter (300 req/min global)
  -> sanitizeQuery (strips dangerous MongoDB operators)
  -> csrfProtection (double-submit cookie)
  -> route-specific middleware (auth, validation, db rules)
  -> route handler
  -> errorHandler (catches unhandled errors)
```

---

## 2. Base URL & Route Prefixes

| Prefix | Purpose |
|--------|---------|
| `/health` | Health check (GET) |
| `/projects/:projectCode/auth` | Tenant user authentication |
| `/projects/:projectCode/db` | Tenant database CRUD |
| `/projects/:projectCode/storage` | Tenant file storage |
| `/projects/:projectCode/test-connection` | Connection test (GET) |
| `/verify` | Email verification (public) |
| `/reset-password` | Password reset (public) |
| `/register` | System admin registration |
| `/login` | System admin login |
| `/me` | System admin profile |
| `/my/projects` | System admin project management |
| `/admin/*` | Superadmin operations |

All tenant routes require `:projectCode` as a URL parameter. The project code identifies the tenant.

---

## 3. Authentication & Authorization

### 3.1 Tenant User Authentication (JWT)

**Token payload**: `{ userId: "<ObjectId>", project: "<projectCode>" }`

**Token lifetime**: 30 days

**How to send the token** (in order of precedence):
1. Cookie named `token` (legacy cookie name)
2. `Authorization: Bearer <jwt>` header

The middleware (`checkDbUserApiAuth`) is **optional** — if no token is provided, `req.sender` is `null` and the request proceeds unauthenticated. Access is then controlled by database rules.

### 3.2 System Admin Authentication (JWT)

**Token payload**: `{ userId: "<ObjectId>", project: "_system" }`

**Cookie name**: `flexdocs-auth-token` or `Authorization: Bearer <jwt>`

System admin tokens set `req.byAdmin = true` and `req.isDbAdmin = true`, which bypasses all database rules.

### 3.3 Private Project Token

For private projects (where `isPublic === false`), non-auth endpoints require the header:

```
project-token: <raw-project-token>
```

The token is SHA-256 hashed and compared (time-safe) against stored credential hashes.

**Exception**: Auth routes (`/login-with-email`, `/register-with-email`, `/login-with-token`, `/anonymous-login`, `/register-with-phone`, `/send-email-verification`, `/send-reset-password-email`) do NOT require the project token even on private projects.

### 3.4 Middleware Chain Per Route Group

| Route group | Middleware applied (in order) |
|-------------|-------------------------------|
| `/:projectCode/auth` | `authLimiter` -> `checkSystemApiAuth` -> `projectApiAuth` -> route-specific |
| `/:projectCode/db` | `checkSystemApiAuth` -> `projectApiAuth` -> `checkDbUserApiAuth` -> route-specific |
| `/:projectCode/storage` | `checkSystemApiAuth` -> `projectApiAuth` -> `checkDbUserApiAuth` -> route-specific |

### 3.5 Account Lockout

- **Threshold**: 10 consecutive failed login attempts
- **Lockout duration**: 15 minutes
- **Reset**: Successful login resets the counter to 0

---

## 4. Headers & Cookies

### Request Headers

| Header | When needed | Value |
|--------|-------------|-------|
| `Authorization` | Authenticated requests | `Bearer <jwt>` |
| `project-token` | Private project non-auth endpoints | Raw project token string |
| `x-csrf-token` | Mutating requests (POST/PUT/DELETE) when using cookies | CSRF token from `csrf-token` cookie |
| `Content-Type` | All requests with body | `application/json` |

### Response Cookies Set by Server

| Cookie | Set when | Purpose |
|--------|----------|---------|
| `flexdocs-auth-token` | System admin login/register | System JWT |
| `db-auth-token` | Tenant user login/register | Tenant JWT |
| `token` | Tenant user login/register (legacy) | Same as `db-auth-token` |
| `csrf-token` | Every response | CSRF double-submit token |

---

## 5. Error Response Format

All errors return JSON:

```json
{
  "message": "Human-readable error description"
}
```

Status codes used:
- `400` — Validation error, bad request, invalid credentials
- `403` — Access denied (rules, CSRF, disabled feature, admin-only)
- `404` — Resource not found, project not found
- `429` — Rate limit exceeded
- `500` — Internal server error

---

## 6. Pagination Conventions

### Defaults

| Param | Default | Max |
|-------|---------|-----|
| `page` | `1` | unlimited |
| `limit` | `20` (collections list), `100` (documents, accounts) | `500` |
| `skip` | Computed as `(page - 1) * limit` | unlimited |

### Paginated Response Shape

For **admin** document queries (status `201`):
```json
{
  "docs": [...],
  "totalCount": 150,
  "page": 1,
  "ipp": 100
}
```

For **non-admin** document queries (status `200`):
```json
[...docs]
```

For **collections list** (status `201`):
```json
{
  "collections": [{ "name": "posts", "documentsCount": 42 }],
  "page": 1,
  "ipp": 20,
  "totalCount": 5
}
```

For **accounts list** (status `201`):
```json
{
  "accounts": [...],
  "totalCount": 100,
  "page": 1,
  "ipp": 100
}
```

For **storage bucket content** (status `200`):
```json
{
  "totalCount": 25,
  "content": [{ ...bucket_or_file }]
}
```

---

## 7. Auth Endpoints

All prefixed with: `/projects/:projectCode/auth`

### 7.1 POST `/register-with-email`

Register a new user account with email and password.

**Rate limit**: 30 req / 15 min

**Request body**:
```json
{
  "email": "user@example.com",
  "password": "secret123",
  "name": "John",          // optional, max 100 chars
  "avatar": "https://...", // optional, max 500 chars
  "roles": ["editor"]      // optional, array of strings
}
```

**Success response** `200`:
```json
{
  "uid": "6507...",
  "token": "eyJ...",
  "name": "John",
  "avatar": "",
  "email": "user@example.com",
  "roles": ["editor"],
  "emailVerified": false
}
```

**Error responses**:
- `403` — Email registration disabled (`allowEmailRegistration` rule is false)
- `400` — Email already registered, weak password (if `requireStrongPassword` is true), validation error

**Side effects**:
- Emits Socket.IO auth event: `{ add: [user] }` on room `${projectCode}/_auth`
- If `requireEmailVerification` is true, automatically sends verification email

---

### 7.2 POST `/login-with-email`

**Rate limit**: 30 req / 15 min

**Request body**:
```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```

**Success response** `200`:
```json
{
  "uid": "6507...",
  "token": "eyJ...",
  "name": "John",
  "avatar": "",
  "email": "user@example.com",
  "roles": ["editor"],
  "emailVerified": true
}
```

**Fields excluded from response**: `_id`, `password`, `createdAt`, `isActive`, `lastLoginAt`, `resetPasswordToken`, `failedLoginAttempts`, `lockedUntil`

**Error responses**:
- `400` — Invalid email or password, account disabled, account locked
- `403` — Email not verified (when `requireEmailVerification` is true)

---

### 7.3 POST `/login-with-token`

Validate an existing JWT and return fresh user data.

**Rate limit**: 30 req / 15 min

**Request body**:
```json
{
  "token": "eyJ..."
}
```

**Success response** `200`: Same shape as login-with-email response.

**Fields excluded from response**: `_id`, `password`, `createdAt`, `isActive`, `lastLoginAt`, `resetPasswordToken`

---

### 7.4 POST `/anonymous-login`

Create an anonymous user (no email/password).

**Rate limit**: 10 req / 15 min (stricter)

**Request body** (all fields optional):
```json
{
  "name": "Guest User",
  "avatar": "https://..."
}
```

**Success response** `200`:
```json
{
  "uid": "6507...",
  "token": "eyJ...",
  "name": "Guest User",
  "avatar": "",
  "isActive": true,
  "lastLoginAt": "2024-01-01T00:00:00.000Z"
}
```

**Error responses**:
- `403` — Anonymous login disabled (`allowAnonymousLogin` rule is false)

**Side effects**: Emits Socket.IO auth event: `{ add: [user] }` on room `${projectCode}/_auth`

---

### 7.5 POST `/change-password`

**Requires**: Authenticated user (Bearer token or cookie)

**Rate limit**: 30 req / 15 min

**Request body**:
```json
{
  "oldPassword": "current123",
  "newPassword": "NewStr0ng!Pass"
}
```

`newPassword` must be strong: 8+ chars, uppercase, lowercase, digit, and symbol.

**Success response** `200`:
```json
{
  "success": true
}
```

---

### 7.6 GET `/send-email-verification`

**Requires**: Authenticated user

**Rate limit**: 30 req / 15 min

**Success response** `200`:
```json
{
  "message": "A verification link was sent to your email!"
}
```

**Error responses**:
- `403` — Email verification disabled
- `400` — No token, account not found, invalid email, already verified

---

### 7.7 POST `/send-reset-password-email`

**Rate limit**: 30 req / 15 min

**Request body**:
```json
{
  "email": "user@example.com"
}
```

**Success response** `200` (always, for security — even if email not found):
```json
{
  "message": "If your email is registered, a reset password email was sent to it!"
}
```

**Error responses**:
- `403` — Password reset disabled

---

### 7.8 Admin Auth Endpoints

All endpoints below this line require system admin authentication (`req.byAdmin === true`). They return `403` for non-admin users.

#### POST `/accounts`

List user accounts with pagination.

**Request body**:
```json
{
  "query": { "emailVerified": true },   // optional, MongoDB filter
  "sort": { "createdAt": -1 },          // optional
  "select": { "email": 1, "name": 1 },  // optional, projection
  "limit": 100,                          // optional, default 100
  "page": 1                              // optional, default 1
}
```

**Success response** `201`:
```json
{
  "accounts": [
    {
      "_id": "6507...",
      "uid": "6507...",
      "email": "user@example.com",
      "name": "John"
    }
  ],
  "totalCount": 42,
  "page": 1,
  "ipp": 100
}
```

Note: Each account has `uid` added as a string copy of `_id`.

---

#### POST `/accounts/add`

Create a new account (admin-initiated).

**Request body**:
```json
{
  "name": "Jane",
  "email": "jane@example.com",
  "password": "secret123",
  "roles": ["moderator"],     // optional
  "avatar": "https://..."     // optional
}
```

**Success response** `200`: Same shape as register-with-email response.

**Side effects**: Emits Socket.IO auth event: `{ add: [account] }` on room `${projectCode}/_auth`

---

#### POST `/accounts/send-verification-email`

**Request body**:
```json
{
  "userId": "6507..."
}
```

**Success response** `200`:
```json
{
  "message": "A verification link was sent to your email!"
}
```

---

#### PUT `/accounts/:id`

Update a user account. Admin can set any field including password (will be hashed server-side).

**Request body**: Any fields to update as key-value pairs.
```json
{
  "name": "New Name",
  "roles": ["admin"],
  "password": "newpassword123",
  "isActive": false
}
```

**Success response** `200`:
```json
{
  "success": 1
}
```

`success` is `matchedCount` (0 or 1).

**Side effects**: Emits Socket.IO auth event: `{ update: [account] }` on room `${projectCode}/_auth`

---

#### DELETE `/accounts/:id`

**Success response** `200`:
```json
{
  "success": 1
}
```

`success` is `deletedCount` (0 or 1).

**Side effects**: Emits Socket.IO auth event: `{ delete: [{ _id: id }] }` on room `${projectCode}/_auth`

---

## 8. Database Endpoints

All prefixed with: `/projects/:projectCode/db`

### 8.1 POST `/collections`

List all user-created collections (excludes collections starting with `_`).

**Request body**:
```json
{
  "where": {},       // optional, MongoDB listCollections filter
  "page": 1,         // optional, default 1
  "limit": 20        // optional, default 20, max 500
}
```

**Success response** `201`:
```json
{
  "collections": [
    { "name": "posts", "documentsCount": 42 },
    { "name": "comments", "documentsCount": 128 }
  ],
  "page": 1,
  "ipp": 20,
  "totalCount": 2
}
```

Collections are sorted alphabetically by name (with numeric sorting).

---

### 8.2 POST `/collections/new`

Create a new collection.

**Request body**:
```json
{
  "name": "posts"
}
```

**Validation rules for collection name**:
- Must start with a letter
- Only alphanumeric and underscore (`[a-zA-Z][a-zA-Z0-9_]*`)
- Max 64 characters
- Cannot be a reserved name: `admin`, `_system`, `_auth`, `_config`, `_projects`, `_buckets`, `_files`, `_users`

**Success response** `201`:
```json
{
  "success": true
}
```

**Error** `400`:
```json
{
  "message": "Collection with this name already exists"
}
```

**Side effects**: Emits Socket.IO event `update:${projectCode}/collections` with `{ add: [{ name, documentsCount: 0 }] }`

---

### 8.3 GET `/:col/filters`

Get all field names present across documents in a collection (samples first 100 docs).

**Middleware**: `collectionMiddleware` (validates collection name + db rules for `read`)

**Success response** `200`:
```json
{
  "fields": ["_id", "title", "body", "author", "createdAt"]
}
```

---

### 8.4 POST `/:col`

Query documents from a collection.

**Middleware**: `collectionMiddleware` (validates collection name + db rules for `read`)

**Request body**:
```json
{
  "query": { "status": "published" },            // optional, MongoDB filter
  "sort": { "createdAt": -1 },                    // optional, 1 = asc, -1 = desc
  "select": { "title": 1, "body": 1 },           // optional, MongoDB projection
  "limit": 100,                                    // optional, default 100, max 500
  "page": 1,                                       // optional, default 1
  "skip": 0                                        // optional, overrides page-based skip
}
```

**Success response for regular users** `200`:
```json
[
  { "_id": "6507...", "title": "Hello", "createdAt": "2024-..." },
  ...
]
```

**Success response for admin users** `201`:
```json
{
  "docs": [...],
  "totalCount": 150,
  "page": 1,
  "ipp": 100
}
```

The difference: admins (system admins with `req.isDbAdmin === true`) get wrapped response with `totalCount`. Regular users get a plain array.

---

### 8.5 POST `/:col/add`

Insert a new document into a collection.

**Middleware**: `collectionMiddleware` (validates collection name + db rules for `add`)

**Request body**: Any JSON object (the document data).
```json
{
  "title": "My Post",
  "body": "Hello world",
  "tags": ["intro"]
}
```

The server automatically adds `createdAt: new Date()` to every document.

**Success response** `200`:
```json
{
  "_id": "6507..."
}
```

**Side effects**:
- If the collection didn't exist before, emits `update:${projectCode}/collections` with `{ add: [{ name, documentsCount: 1 }] }`
- If the collection existed, emits `update:${projectCode}/collections` with `{ update: [{ name, documentsCount: N+1 }] }`
- Emits `update:${projectCode}/${col}` with `{ add: [{ _id, ...data, createdAt }] }`

---

### 8.6 GET `/:col/:id`

Get a single document by ID.

**Middleware**: `documentMiddleware` (validates collection + db rules for `read` with doc context)

**URL params**:
- `:col` — Collection name
- `:id` — 24-character hex ObjectId

**Success response** `200`:
```json
{
  "_id": "6507...",
  "title": "My Post",
  "createdAt": "2024-01-01T00:00:00.000Z"
}
```

**Error responses**:
- `400` — Invalid ObjectId format
- `404` — Document not found

---

### 8.7 PUT `/:col/:id`

Update a single document.

**Middleware**: `documentMiddleware` (validates collection + db rules for `update` with doc context)

**Request body**:
```json
{
  "data": {
    "title": "Updated Title",
    "status": "draft"
  },
  "type": "update"
}
```

| `type` value | Behavior |
|-------------|----------|
| `"update"` (default) | Uses `$set` — merges fields |
| `"replace"` | Uses `replaceOne` — replaces entire document |

The `_id` field is automatically stripped from `data` if present.

**Success response** `200`:
```json
{
  "message": "Document updated successfully"
}
```

**Other status messages**:
- `200` — `"No changes made, but document exists"` (matched but nothing changed)
- `404` — `"Document not found"`

**Side effects**:
- Emits to Socket.IO room `<docId>` → `{ action: "update", doc: {...} }`
- Emits `update:${projectCode}/${col}` with `{ update: [doc] }`

---

### 8.8 DELETE `/:col/:id`

Delete a single document.

**Middleware**: `documentMiddleware` (validates collection + db rules for `delete` with doc context)

**Success response** `200`:
```json
{
  "message": "Document was deleted successfully"
}
```

**Error** `404`: `"Document not found"`

**Side effects**:
- Emits to Socket.IO room `<docId>` → `{ action: "delete", doc: {...} }`
- Emits `update:${projectCode}/${col}` with `{ delete: [doc] }`
- Emits `update:${projectCode}/collections` with updated document count

---

### 8.9 PUT `/:col`

Update multiple documents.

**Middleware**: `dbRulesAuth` (rule-based access control)

**Request body**:
```json
{
  "filter": { "status": "draft" },
  "newData": { "status": "published" }
}
```

Uses `$set` for the update. Both `filter` and `newData` are required.

**Success response** `200`:
```json
{
  "message": "Documents were updated successfully"
}
```

**Other status messages**:
- `200` — `"No changes made, but documents exists"`
- `404` — `"Document not found"` (no documents matched)

---

### 8.10 DELETE `/:col`

Delete multiple documents.

**Middleware**: `dbRulesAuth` (rule-based access control)

**Request body**:
```json
{
  "filter": { "status": "archived" }
}
```

`filter` is required for non-admin users. If admin sends empty/no filter, the entire collection is dropped.

**Success response** `200`:
```json
{
  "message": "Documents were deleted successfully"
}
```

**Admin with no filter** `200`:
```json
{
  "message": "Collection was deleted successfully"
}
```

---

## 9. Storage Endpoints

All prefixed with: `/projects/:projectCode/storage`

### 9.1 GET `/buckets/:bucketId/content`

List bucket contents (buckets first, then files).

**URL params**:
- `:bucketId` — ObjectId or `"home"` (for root-level content)

**Query params**:
- `page` — default `1`
- `ipp` — items per page, default `20`

**Success response** `200`:
```json
{
  "totalCount": 25,
  "content": [
    {
      "_id": "6507...",
      "name": "images",
      "type": "bucket",
      "description": "Image uploads",
      "parentId": null,
      "createdAt": "2024-..."
    },
    {
      "_id": "6508...",
      "name": "photo",
      "type": "file",
      "ext": "jpg",
      "size": 204800,
      "bucketId": "6507...",
      "isPublic": true,
      "createdAt": "2024-..."
    }
  ]
}
```

Content is sorted by `createdAt` descending. Buckets appear before files in the results.

---

### 9.2 POST `/search`

Search files and buckets by name.

**Request body**:
```json
{
  "searchTerm": "photo",         // required, min 1 char, max 200
  "bucketId": "6507...",         // optional, scope to a bucket
  "page": 1,                     // optional
  "ipp": 20                      // optional, max 100
}
```

If `searchTerm` contains a dot (e.g., `"image.png"`), it does an exact match on name and extension separately. Otherwise, it does a regex (case-insensitive) match on the name field.

**Success response** `200`: Same shape as bucket content response.

---

### 9.3 POST `/buckets`

Create a new bucket.

**Request body**:
```json
{
  "name": "avatars",             // required, max 100
  "description": "User avatars", // optional, max 500
  "parentId": "6507..."          // optional, null for root
}
```

**Success response** `200`:
```json
{
  "_id": "6509...",
  "name": "avatars",
  "type": "bucket",
  "description": "User avatars",
  "parentId": null,
  "isPublic": false,
  "createdAt": "2024-..."
}
```

**Side effects**: Emits storage socket event `{ add: [bucket] }` on room `${projectCode}-storage`

---

### 9.4 PUT `/buckets/:bucketId`

Update a bucket's name or description.

**Request body**:
```json
{
  "name": "new-name",            // optional
  "description": "Updated desc"  // optional
}
```

**Success response** `200`:
```json
{
  "message": "Bucket was updated successfully"
}
```

**Side effects**: Emits storage socket event `{ update: [bucket] }` on room `${projectCode}-storage`

---

### 9.5 DELETE `/buckets/:bucketId`

Delete a bucket and all its contents recursively (sub-buckets, files, filesystem data).

**Success response** `200`:
```json
{
  "message": "Bucket was deleted successfully"
}
```

**Side effects**: Emits storage socket event `{ delete: [bucketId] }` on room `${projectCode}-storage`

---

### 9.6 DELETE `/files/:fileId`

Delete a single file (document + filesystem).

**Success response** `200`:
```json
{
  "message": "File was deleted successfully"
}
```

**Side effects**: Emits storage socket event `{ delete: [fileId] }` on room `${projectCode}-storage`

---

### 9.7 GET `/:fileId/:filename`

Download/serve a file.

**URL params**:
- `:fileId` — ObjectId of the file
- `:filename` — Must match `${file.name}.${file.ext}` exactly

**Query params**:
- `size` — `"small"` (300px), `"medium"` (800px), `"large"` (1200px) — only for images
- `token` — JWT token for accessing private files

**Access control**:
- Public files (`isPublic: true`): No token needed
- Private files: Requires either admin auth or a valid JWT token whose `project` claim matches the project code

**Image resizing**:
- Supported formats: jpg, jpeg, gif, png, webp
- Quality: 80% JPEG
- Resized versions are cached to disk
- Images are never upscaled beyond their original width

**Response**: Raw file binary with appropriate content type (`res.sendFile`)

**Errors**:
- `404` — File not found or filename mismatch
- `403` — Access denied (private file, no/invalid token)

---

## 10. Socket.IO Real-Time API

### 10.1 Connection

**URL**: Same as HTTP server (Socket.IO upgrades from HTTP)

**Authentication** (passed in handshake):
```javascript
const socket = io("https://api.example.com", {
  auth: {
    projectToken: "<jwt-containing-project-code>",  // required
    userToken: "<user-jwt>",                          // optional
    token: "<system-admin-jwt>"                       // optional (for admin)
  }
});
```

Alternative: pass as query params `?projectToken=...&userToken=...`

The `projectToken` is a JWT with payload `{ code: "<projectCode>" }`. It identifies which project the socket belongs to.

After connection, `socket.project` is set to the project document and `socket.sender` is set to the user document (if `userToken` was valid).

### 10.2 Post-Connection User Token Update

```javascript
// Client -> Server
socket.emit("set-user-token", "<new-user-jwt>");

// To clear the user:
socket.emit("set-user-token", null);
```

This updates `socket.sender` for subsequent db rules checks.

---

### 10.3 Database Events

#### Watch a Single Document

```javascript
// Client -> Server
socket.emit("watch-doc", { path: "/<collectionName>/<docId>" });

// Server -> Client (on the document ID as event name)
socket.on("<docId>", (data) => {
  // data = { action: "update", doc: {...} }
  // data = { action: "delete" }  (when doc no longer exists)
  // data = { action: "delete", doc: {...} }  (when doc is deleted via API)
});
```

The client joins a Socket.IO room named `<docId>`. Any subsequent PUT or DELETE on that document triggers an emit to that room.

#### Watch Collection Updates

```javascript
// Client -> Server
socket.emit("watch-col-updates", { col: "<collectionName>" });

// Server -> Client
socket.on("update:<projectCode>/<collectionName>", (data) => {
  // data = { add: [doc1, doc2, ...] }      — when documents are added
  // data = { update: [doc1, doc2, ...] }   — when documents are updated
  // data = { delete: [doc1, doc2, ...] }   — when documents are deleted
});
```

#### Watch Collections List (Admin)

```javascript
// Client -> Server (requires admin auth)
socket.emit("watch-collections", {});

// Server -> Client
socket.on("update:<projectCode>/collections", (data) => {
  // data = { add: [{ name: "posts", documentsCount: 0 }] }
  // data = { update: [{ name: "posts", documentsCount: 42 }] }
  // data = { delete: [{ name: "posts" }] }
});
```

---

### 10.4 Auth Events

#### Watch Accounts (Admin)

```javascript
// Client -> Server
socket.emit("watch-accounts", {});

// Server -> Client
socket.on("<projectCode>/_auth", (data) => {
  // data = { add: [account1, ...] }
  // data = { update: [account1, ...] }
  // data = { delete: [{ _id: "..." }] }
});
```

---

### 10.5 Storage Events

#### Watch Buckets/Files (Admin)

```javascript
// Client -> Server
socket.emit("watch-buckets", {});

// Server -> Client
socket.on("<projectCode>-storage", (data) => {
  // data = { add: [bucketOrFile], update: null, delete: null }
  // data = { add: null, update: [bucket], delete: null }
  // data = { add: null, update: null, delete: [id] }
});
```

```javascript
// Stop watching
socket.emit("stop-watch-buckets", {});
```

---

## 11. Database Rules (JEXL)

Database rules control access to collections and documents using JEXL expressions.

### 11.1 Rule Structure

Rules are an object where keys are paths and values are access control definitions:

```json
{
  "/posts": {
    "read": true,
    "add": "user != null",
    "update": "user._id == doc.authorId",
    "delete": false
  },
  "/posts/[id]": {
    "read": true,
    "update": "user._id == doc.authorId",
    "delete": "user.roles | includes('admin')"
  },
  "/private": false,
  "/public": true
}
```

### 11.2 Path Patterns

| Pattern | Matches |
|---------|---------|
| `/<collectionName>` | All collection-level operations |
| `/<collectionName>/[id]` | All single-document operations (dynamic) |
| `/<collectionName>/<specificDocId>` | A specific document by ID |

### 11.3 Rule Values

| Value | Meaning |
|-------|---------|
| `true` | Always allow |
| `false` | Always deny |
| `"<jexl expression>"` | Evaluate; truthy = allow |

### 11.4 JEXL Context Variables

| Variable | Type | Description |
|----------|------|-------------|
| `user` | `object \| null` | The authenticated user (`req.sender`). `null` if unauthenticated |
| `doc` | `object \| null` | The target document (for document-level rules) |
| `body` | `object \| null` | The request body |

### 11.5 Action Mapping

| HTTP Method + Path Pattern | Action |
|---------------------------|--------|
| `POST /:col` (query) | `read` |
| `GET /:col/:id` | `read` |
| `POST /:col/add` | `add` |
| `PUT /:col/:id` | `update` |
| `PUT /:col` (updateMany) | `update` |
| `DELETE /:col/:id` | `delete` |
| `DELETE /:col` (deleteMany) | `delete` |

### 11.6 Rule Resolution Order (for document paths)

1. Check for exact doc path rule: `/<col>/<docId>`
2. Check for dynamic doc path rule: `/<col>/[id]`
3. Fall back to collection path rule: `/<col>`
4. If no rule defined for the path → **allow** (default open)

### 11.7 JEXL Timeout

All JEXL expressions have a **100ms timeout**. On timeout, the rule evaluates to `false` (deny).

---

## 12. Auth Rules

Auth rules are boolean flags that control which authentication features are enabled per project.

```json
{
  "allowEmailRegistration": true,
  "allowAnonymousLogin": true,
  "requireStrongPassword": false,
  "allowPasswordReset": true,
  "allowEmailVerification": true,
  "requireEmailVerification": false
}
```

| Rule | Default | Effect when `false` |
|------|---------|---------------------|
| `allowEmailRegistration` | `true` | `POST /register-with-email` returns 403 |
| `allowAnonymousLogin` | `true` | `POST /anonymous-login` returns 403 |
| `requireStrongPassword` | `false` | When `true`, passwords must be 8+ chars with upper, lower, digit, and symbol |
| `allowPasswordReset` | `true` | `POST /send-reset-password-email` returns 403 |
| `allowEmailVerification` | `true` | `GET /send-email-verification` returns 403 |
| `requireEmailVerification` | `false` | When `true`, unverified users get 403 on login + auto-sends verification on register |

---

## 13. Query Format & Special Operators

### 13.1 Query Object Processing

All query/filter objects go through `formatQueryObj()` which provides:

**ObjectId conversion**:
```json
{ "_id": "6507a1b2c3d4e5f6a7b8c9d0" }
// -> { "_id": ObjectId("6507a1b2c3d4e5f6a7b8c9d0") }

{ "$oid": "6507a1b2c3d4e5f6a7b8c9d0" }
// -> ObjectId("6507a1b2c3d4e5f6a7b8c9d0")
```

**Date conversion**:
```json
{ "$date": "2024-01-01T00:00:00.000Z" }
// -> Date("2024-01-01T00:00:00.000Z")
```

### 13.2 Blocked Operators

These MongoDB operators are **always rejected** (throw error):
- `$where` — arbitrary JavaScript execution
- `$function` — arbitrary JavaScript execution
- `$accumulator` — arbitrary JavaScript execution

### 13.3 Sanitized Operators (Query Middleware)

The `sanitizeQuery` middleware strips unknown operators from query strings. Allowed operators:

**Comparison**: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`
**Logical**: `$and`, `$or`, `$not`, `$nor`
**Element**: `$exists`, `$type`
**Array**: `$all`, `$elemMatch`, `$size`
**Evaluation**: `$regex`, `$options`, `$mod`, `$text`, `$search`, `$expr`

### 13.4 Query Timeout

All read queries have a **10-second timeout** (`maxTimeMS: 10000`) on the MongoDB server.

---

## 14. Validation Schemas (Zod)

Every endpoint validates its input using Zod schemas. The middleware returns `400` with:

```json
{
  "message": "Validation error",
  "errors": [
    {
      "path": ["email"],
      "message": "Invalid email format"
    }
  ]
}
```

### Key field constraints

| Field | Type | Constraints |
|-------|------|-------------|
| `email` | string | Valid email, max 255, trimmed, lowercased |
| `password` | string | Min 1, max 128 |
| `strongPassword` | string | Min 8, max 128, must match `/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/` |
| `objectIdString` | string | Must match `/^[a-f0-9]{24}$/i` |
| `projectCode` | string | Min 1, max 64, must match `/^[a-zA-Z][a-zA-Z0-9_-]*$/` |
| `collectionName` | string | Min 1, max 64, must match `/^[a-zA-Z][a-zA-Z0-9_]*$/`, not reserved |
| `query` | object | `Record<string, unknown>`, optional |
| `sort` | object | `Record<string, 1 \| -1>`, optional |
| `select` | object | `Record<string, 0 \| 1>`, optional |
| `limit` | number | Int, min 1, max 500 |
| `page` | number | Int, min 1 |
| `skip` | number | Int, min 0 |

---

## 15. Rate Limiting

| Limiter | Window | Max Requests | Applied to |
|---------|--------|-------------|------------|
| `apiLimiter` | 1 minute | 300 (default) | All routes (global) |
| `authLimiter` | 15 minutes | 30 (default) | Auth routes |
| `anonLoginLimiter` | 15 minutes | 10 (default) | Anonymous login only |

Configurable via environment variables:
- `RATE_LIMIT_API_MAX` — Global limit (default 300)
- `RATE_LIMIT_AUTH_MAX` — Auth limit (default 30)
- `RATE_LIMIT_ANON_MAX` — Anonymous login limit (default 10)

Rate limit exceeded response `429`:
```json
{
  "message": "Too many requests, please try again later."
}
```

---

## 16. CSRF Protection

Uses double-submit cookie pattern.

- Cookie `csrf-token` is set on every response
- Mutating requests (POST, PUT, DELETE) must include `x-csrf-token` header matching the cookie value
- **Exempt**: Requests using only `Authorization: Bearer` (no cookies)
- **Exempt**: GET requests

---

## 17. File Upload Protocol (Socket.IO)

File uploads use a chunked protocol over Socket.IO (not HTTP).

### Upload Flow

```
Client                          Server
  |                               |
  |-- upload:start { fileInfo } -->|
  |                               |-- validates file
  |<-- upload:ready { name } -----|
  |                               |
  |-- upload:chunk { name, chunk } -->|  (repeat for each chunk)
  |<-- upload:progress { name, received } --|
  |                               |
  |-- upload:done name ---------->|
  |                               |-- saves to DB
  |<-- upload:complete { ... } ---|
```

### upload:start payload

```javascript
{
  name: "photo.jpg",        // required, full filename with extension
  size: 204800,             // optional, file size in bytes (for upfront validation)
  bucket: "avatars"         // optional, bucket name or ObjectId
}
```

### upload:chunk payload

```javascript
{
  name: "photo.jpg",        // must match the name from upload:start
  chunk: ArrayBuffer         // binary data chunk (converted to Buffer server-side)
}
```

### upload:complete response

```javascript
{
  name: "photo.jpg",
  filename: "org.jpg",       // stored filename on disk
  url: "<downloadable-link>",
  size: 204800               // final file size
}
```

### upload:error response

```javascript
{
  name: "photo.jpg",
  message: "Error description"
}
```

### Upload Constraints

| Constraint | Value |
|-----------|-------|
| Max file size | 50 MB |
| Max filename length | 255 characters |
| Max concurrent uploads per socket | 5 |
| Blocked extensions | exe, bat, cmd, com, msi, scr, pif, vbs, wsf, wsh |
| Path separators in filename | Rejected (path traversal prevention) |

### Filesystem Storage

Files are stored at: `data/storage/<projectCode>/<fileId>/org.<ext>`

Resized images are stored alongside: `data/storage/<projectCode>/<fileId>/small.<ext>`, `medium.<ext>`, `large.<ext>`

---

## 18. Data Models & Shapes

### 18.1 User (Tenant Account) — `_users` collection

```javascript
{
  _id: ObjectId,
  email: String,           // unique per project (optional for anonymous)
  password: String,        // bcrypt hash (optional for anonymous)
  name: String,
  avatar: String,
  roles: [String],
  emailVerified: Boolean,
  isActive: Boolean,
  lastLoginAt: Date,
  failedLoginAttempts: Number,
  lockedUntil: Date,
  resetPasswordToken: String,
  createdAt: Date
}
```

### 18.2 Auth Response (Login/Register return value)

```javascript
{
  uid: String,             // _id as string
  token: String,           // JWT
  name: String,
  avatar: String,
  email: String,
  roles: [String],
  emailVerified: Boolean
  // Note: _id, password, createdAt, isActive, lastLoginAt,
  //       resetPasswordToken, failedLoginAttempts, lockedUntil
  //       are EXCLUDED from the response
}
```

### 18.3 Anonymous Login Response

```javascript
{
  uid: String,
  token: String,
  name: String,
  avatar: String,
  isActive: Boolean,
  lastLoginAt: Date
}
```

### 18.4 Document (User Collection)

```javascript
{
  _id: ObjectId,
  // ...user-defined fields...
  createdAt: Date          // auto-added on insert
}
```

### 18.5 Bucket — `_buckets` collection

```javascript
{
  _id: ObjectId,
  name: String,
  description: String,
  parentId: ObjectId | null,
  type: "bucket",
  isPublic: Boolean,
  createdAt: Date
}
```

### 18.6 File — `_files` collection

```javascript
{
  _id: ObjectId,
  bucketId: ObjectId | null,
  name: String,            // without extension
  ext: String,             // file extension
  size: Number,            // bytes
  projectCode: String,
  dir: String,             // filesystem directory path
  type: "file",
  isPublic: Boolean,
  accessedAt: Date,
  createdAt: Date
}
```

### 18.7 Collection Info (from list)

```javascript
{
  name: String,
  documentsCount: Number
}
```

---

## 19. Constants & Limits

### Reserved Collection Names
```
admin, _system, _auth, _config, _projects, _buckets, _files, _users
```

### Token Expiry
| Token type | Expiry |
|-----------|--------|
| Auth (login/register) | 30 days |
| Verification/Reset | 10 minutes |

### Image Resize Dimensions
| Size | Max width (px) |
|------|---------------|
| `small` | 300 |
| `medium` | 800 |
| `large` | 1200 |

### Cookie Names
| Purpose | Cookie name |
|---------|-------------|
| System admin auth | `flexdocs-auth-token` |
| Tenant user auth | `db-auth-token` |
| Legacy user auth | `token` |

### File Download URL Format
```
/projects/:projectCode/storage/:fileId/:name.:ext?size=small&token=<jwt>
```

---

## 20. Multi-Tenancy Model

Each project is a fully isolated tenant:

```
System Database ("_system")
├── _users (system admins)
└── projects (project metadata + rules + credentials)

Project Database ("<projectCode>")
├── _users (project user accounts)
├── _buckets (storage bucket metadata)
├── _files (stored file metadata)
├── posts (user-created collection)
├── comments (user-created collection)
└── ... (any user-created collections)
```

### Project identification in requests

- **HTTP**: `:projectCode` URL parameter in `/projects/:projectCode/...`
- **Socket.IO**: Decoded from `projectToken` JWT in handshake auth

### Data isolation guarantees

- Each project gets its own MongoDB database (named by project code)
- File storage is isolated per project: `data/storage/<projectCode>/`
- JWT tokens contain the project code — tokens from one project cannot access another
- Database rules, auth rules, and storage rules are per-project
- User accounts are per-project (same email can exist in different projects)

### Admin access

System admins (`req.byAdmin === true`) bypass all database rules and have full access to all project data via the admin middleware chain.
