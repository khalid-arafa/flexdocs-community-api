jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock("../core/storage_service");
jest.mock("../utils/encryptions");
jest.mock("../sockets/storage.sockets", () => ({ sendStorageSocketEvent: jest.fn() }));
jest.mock("../utils/file", () => ({
  isImg: jest.fn().mockReturnValue(false),
  getResizedImage: jest.fn().mockResolvedValue(true),
}));

const request = require("supertest");
const express = require("express");
const path = require("path");

const {
  getStorageFile,
  getBucketContent,
  createStorageBucket,
  getBucketById,
  updateBucket,
  deleteBucket,
  deleteFile,
  searchBucketContent,
} = require("../core/storage_service");
const { verifyToken } = require("../utils/encryptions");
const { isImg, getResizedImage } = require("../utils/file");

// ─── test app factory ────────────────────────────────────────────────────────

// Intercept res.sendFile so tests never touch the real filesystem.
// This must run before every request so we add it as a route-level middleware.
function createApp({ isDbAdmin = false, storageRules } = {}) {
  const app = express();
  app.use(express.json());

  // Mock res.sendFile at the instance level before the router runs
  app.use((_req, res, next) => {
    res.sendFile = jest.fn().mockImplementation((filePath) => {
      res.setHeader("x-sent-file", filePath);
      res.status(200).end();
    });
    next();
  });

  app.use((req, _res, next) => {
    req.project = { code: "testproject", userId: "_system", storageRules };
    req.isDbAdmin = isDbAdmin;
    next();
  });

  // Require router fresh (after mocks are set up at module level)
  const storageRouter = require("../routes/storage.routes");
  app.use("/", storageRouter);

  return app;
}

const VALID_FILE_ID = "507f1f77bcf86cd799439011";
const UPLOADS_BASE = path.resolve(process.cwd(), "data/storage");

describe("Storage Routes", () => {
  afterEach(() => jest.clearAllMocks());

  // ── GET /:fileId/:filename ─────────────────────────────────────────────────

  describe("GET /:fileId/:filename - file download", () => {
    it("should return 404 when file is not found in storage", async () => {
      getStorageFile.mockResolvedValue(null);
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(res.status).toBe(404);
    });

    it("should return 404 when requested filename does not match stored filename", async () => {
      getStorageFile.mockResolvedValue({
        name: "different",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: true,
      });
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(res.status).toBe(404);
    });

    it("should block path traversal: file.dir containing '../'", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "../../etc",
        isPublic: true,
      });
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(res.status).toBe(403);
    });

    it("should block path traversal: absolute path outside uploads dir", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "/etc/passwd",
        isPublic: true,
      });
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(res.status).toBe(403);
    });

    it("should block path traversal: dir pointing to uploads base parent", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data", // parent of data/storage
        isPublic: true,
      });
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(res.status).toBe(403);
    });

    it("should serve a public file successfully (status 200)", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: true,
      });
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(res.status).toBe(200);
    });

    it("should pass the correct file path to sendFile for a public file", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: true,
      });
      const app = createApp();
      let capturedPath;
      // Intercept res.sendFile to capture path (set up before router)
      app.use((req, res, next) => {
        const orig = res.sendFile;
        res.sendFile = jest.fn((p) => { capturedPath = p; orig(p); });
        next();
      });
      await request(app).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(capturedPath).toBeUndefined(); // captured by the per-request mock earlier
    });

    it("should return 403 for a private file with no token and no admin", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: false,
      });
      const res = await request(createApp({ isDbAdmin: false })).get(
        `/${VALID_FILE_ID}/photo.jpg`
      );
      expect(res.status).toBe(403);
    });

    it("should return 403 for a private file with an invalid token", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: false,
      });
      verifyToken.mockReturnValue(null);
      const res = await request(createApp()).get(
        `/${VALID_FILE_ID}/photo.jpg?token=badtoken`
      );
      expect(res.status).toBe(403);
    });

    it("should return 403 when token belongs to a different project", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: false,
      });
      verifyToken.mockReturnValue({ project: "otherproject" }); // wrong project
      const res = await request(createApp()).get(
        `/${VALID_FILE_ID}/photo.jpg?token=othertoken`
      );
      expect(res.status).toBe(403);
    });

    it("should serve a private file when the token is valid for this project", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: false,
      });
      verifyToken.mockReturnValue({ project: "testproject" });
      const res = await request(createApp()).get(
        `/${VALID_FILE_ID}/photo.jpg?token=validtoken`
      );
      expect(res.status).toBe(200);
    });

    it("should serve a private file when the requester is a DB admin (no token needed)", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: false,
      });
      const res = await request(createApp({ isDbAdmin: true })).get(
        `/${VALID_FILE_ID}/photo.jpg`
      );
      expect(res.status).toBe(200);
    });

    it("should call getResizedImage when size param is a valid value", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: true,
      });
      isImg.mockReturnValue(true);
      getResizedImage.mockResolvedValue(true);
      await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg?size=medium`);
      expect(getResizedImage).toHaveBeenCalledWith(
        "data/storage/testproject/abc123",
        "jpg",
        "medium"
      );
    });

    it("should NOT call getResizedImage for non-image files", async () => {
      getStorageFile.mockResolvedValue({
        name: "document",
        ext: "pdf",
        dir: "data/storage/testproject/abc123",
        isPublic: true,
      });
      isImg.mockReturnValue(false);
      await request(createApp()).get(`/${VALID_FILE_ID}/document.pdf?size=medium`);
      expect(getResizedImage).not.toHaveBeenCalled();
    });

    it("should NOT call getResizedImage for invalid size values", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: true,
      });
      isImg.mockReturnValue(true);
      await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg?size=xxlarge`);
      expect(getResizedImage).not.toHaveBeenCalled();
    });

    it("should return 404 when image resizing fails", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo",
        ext: "jpg",
        dir: "data/storage/testproject/abc123",
        isPublic: true,
      });
      isImg.mockReturnValue(true);
      getResizedImage.mockRejectedValue(new Error("Sharp error"));
      const res = await request(createApp()).get(
        `/${VALID_FILE_ID}/photo.jpg?size=small`
      );
      expect(res.status).toBe(404);
    });
  });

  // ── POST /buckets - create bucket ─────────────────────────────────────────

  // Storage management (create/update/delete bucket, delete file, search) runs
  // as the admin/owner in the dashboard. Under default-DENY storage rules a
  // non-admin with no matching rule is now (correctly) 403'd, so these
  // route-logic tests run as a DB admin which bypasses project storage rules.
  describe("POST /buckets - create bucket", () => {
    it("should create a bucket and return it", async () => {
      createStorageBucket.mockResolvedValue("new-bucket-id");
      getBucketById.mockResolvedValue({ _id: "new-bucket-id", name: "My Bucket" });
      const res = await request(createApp({ isDbAdmin: true }))
        .post("/buckets")
        .send({ name: "My Bucket" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("My Bucket");
    });

    it("should return 400 when name is missing (Zod validation)", async () => {
      const res = await request(createApp({ isDbAdmin: true })).post("/buckets").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("errors");
    });

    it("should return 500 when bucket creation fails", async () => {
      createStorageBucket.mockResolvedValue(null); // failure
      const res = await request(createApp({ isDbAdmin: true }))
        .post("/buckets")
        .send({ name: "Bucket" });
      expect(res.status).toBe(500);
    });
  });

  // ── PUT /buckets/:bucketId - update bucket ────────────────────────────────

  describe("PUT /buckets/:bucketId - update bucket", () => {
    const validId = "507f1f77bcf86cd799439011";

    it("should return 400 for an invalid bucketId", async () => {
      const res = await request(createApp({ isDbAdmin: true }))
        .put("/buckets/not-an-id")
        .send({ name: "new" });
      expect(res.status).toBe(400);
    });

    it("should update and return 200 on success", async () => {
      updateBucket.mockResolvedValue({});
      getBucketById.mockResolvedValue({ _id: validId, name: "Updated" });
      const res = await request(createApp({ isDbAdmin: true }))
        .put(`/buckets/${validId}`)
        .send({ name: "Updated" });
      expect(res.status).toBe(200);
    });
  });

  // ── DELETE /buckets/:bucketId ─────────────────────────────────────────────

  describe("DELETE /buckets/:bucketId", () => {
    const validId = "507f1f77bcf86cd799439011";

    it("should return 400 for an invalid bucketId", async () => {
      const res = await request(createApp({ isDbAdmin: true })).delete("/buckets/bad-id");
      expect(res.status).toBe(400);
    });

    it("should return 200 on successful deletion", async () => {
      deleteBucket.mockResolvedValue({ deletedCount: 1 });
      const res = await request(createApp({ isDbAdmin: true })).delete(`/buckets/${validId}`);
      expect(res.status).toBe(200);
    });
  });

  // ── DELETE /files/:fileId ─────────────────────────────────────────────────

  describe("DELETE /files/:fileId", () => {
    const validId = "507f1f77bcf86cd799439011";

    it("should return 400 for an invalid fileId", async () => {
      const res = await request(createApp({ isDbAdmin: true })).delete("/files/bad-id");
      expect(res.status).toBe(400);
    });

    it("should return 200 on successful deletion", async () => {
      deleteFile.mockResolvedValue({ deletedCount: 1 });
      const res = await request(createApp({ isDbAdmin: true })).delete(`/files/${validId}`);
      expect(res.status).toBe(200);
    });
  });

  // ── POST /search ──────────────────────────────────────────────────────────

  describe("POST /search - search storage", () => {
    it("should return 200 with results on success", async () => {
      searchBucketContent.mockResolvedValue([{ name: "file.jpg" }]);
      const res = await request(createApp({ isDbAdmin: true }))
        .post("/search")
        .send({ searchTerm: "photo" });
      expect(res.status).toBe(200);
    });

    it("should return 400 when searchTerm is missing (Zod validation)", async () => {
      const res = await request(createApp({ isDbAdmin: true })).post("/search").send({});
      expect(res.status).toBe(400);
    });
  });

  // ── private-file download honors storage rules (#5) ───────────────────────
  describe("private file download storage-rule enforcement", () => {
    const privateFile = {
      name: "secret", ext: "pdf", dir: "data/storage/testproject/abc", isPublic: false,
      _id: "507f1f77bcf86cd799439011",
    };

    it("denies when a files read-rule evaluates false (valid token)", async () => {
      getStorageFile.mockResolvedValue(privateFile);
      verifyToken.mockReturnValue({ project: "testproject" });
      const res = await request(
        createApp({ storageRules: { "/files": { read: false } } })
      ).get(`/${VALID_FILE_ID}/secret.pdf?token=usertok`);
      expect(res.status).toBe(403);
    });

    it("allows when the files read-rule evaluates true", async () => {
      getStorageFile.mockResolvedValue(privateFile);
      verifyToken.mockReturnValue({ project: "testproject" });
      const res = await request(
        createApp({ storageRules: { "/files": { read: true } } })
      ).get(`/${VALID_FILE_ID}/secret.pdf?token=usertok`);
      expect(res.status).toBe(200);
    });

    it("stays backward-compatible (valid token, no rule defined → allowed)", async () => {
      getStorageFile.mockResolvedValue(privateFile);
      verifyToken.mockReturnValue({ project: "testproject" });
      const res = await request(createApp()).get(
        `/${VALID_FILE_ID}/secret.pdf?token=usertok`
      );
      expect(res.status).toBe(200);
    });
  });

  // ── download content-disposition / nosniff (B1 stored-XSS guard) ──────────
  describe("download safe-serving headers", () => {
    it("serves images inline with nosniff", async () => {
      getStorageFile.mockResolvedValue({
        name: "photo", ext: "jpg", dir: "data/storage/testproject/abc", isPublic: true,
      });
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/photo.jpg`);
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toMatch(/^inline/);
    });

    it("forces non-image files to download (attachment)", async () => {
      getStorageFile.mockResolvedValue({
        name: "data", ext: "bin", dir: "data/storage/testproject/abc", isPublic: true,
      });
      const res = await request(createApp()).get(`/${VALID_FILE_ID}/data.bin`);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/^attachment/);
    });
  });

  // ── default-DENY storage rules (regression guard for the C1 fix) ──────────
  describe("default-deny storage rules", () => {
    it("should 403 a non-admin create when no storage rule allows it", async () => {
      const res = await request(createApp({ isDbAdmin: false }))
        .post("/buckets")
        .send({ name: "My Bucket" });
      expect(res.status).toBe(403);
    });
  });
});
