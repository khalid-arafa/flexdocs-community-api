const { ObjectId } = require("mongodb");
const express = require("express");
const router = express.Router();
const {
  getStorageFile,
  getBucketContent,
  deleteBucket,
  deleteFile,
  updateBucket,
  getBucketById,
  getFileById,
  updateFile,
  createStorageBucket,
  searchBucketContent,
} = require("../core/storage_service");
const {
  isImg,
  getResizedImage,
  contentDisposition,
  sameFileName,
} = require("../utils/file");
const path = require("path");
const { sendStorageSocketEvent } = require("../sockets/storage.sockets");
const { verifyToken } = require("../utils/encryptions");
const { zodValidate } = require("../middleware/zod_validate.middleware");
const { storageGuard, checkStorageRule } = require("../middleware/storage_rules.middleware");
const { getDocument } = require("../core/db_service");
const { authCollectionName } = require("../constants");
const {
  createBucketSchema,
  updateBucketSchema,
  searchStorageSchema,
  updateFileSchema,
} = require("../utils/schemas");

// Document loaders for document-level storage rules.
const loadBucket = (req) =>
  ObjectId.isValid(req.params.bucketId)
    ? getBucketById({
        userId: req.project.userId,
        projectCode: req.project.code,
        id: req.params.bucketId,
      })
    : null;
const loadFile = (req) =>
  ObjectId.isValid(req.params.fileId)
    ? getFileById({
        userId: req.project.userId,
        projectCode: req.project.code,
        id: req.params.fileId,
      })
    : null;
const { uploadsPath, uploadLimits } = require("../constants");
const Logger = require("../utils/logger");

// Resolved absolute base for all uploads — used to prevent path traversal.
const UPLOADS_BASE = path.resolve(process.cwd(), uploadsPath);

// get bucket content
router.get("/buckets/:bucketId/content", storageGuard("read", "files"), async (req, res) => {
  const { bucketId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const ipp = parseInt(req.query.ipp) || 20;

  const data = await getBucketContent({
    userId: req.project.userId,
    projectCode: req.project.code,
    bucketId: bucketId == "home" ? null : bucketId,
    limit: ipp,
    skip: (page - 1) * ipp,
  });
  return res.status(200).json(data);
});

router.post("/search", storageGuard("read", "files"), zodValidate(searchStorageSchema), async (req, res) => {
  let { bucketId, searchTerm, page, ipp } = req.body;
  try {
    const data = await searchBucketContent({
      userId: req.project.userId,
      projectCode: req.project.code,
      bucketId,
      limit: ipp,
      skip: (page - 1) * ipp,
      searchTerm,
    });
    return res.status(200).json(data);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// create a bucket
router.post("/buckets", storageGuard("add", "buckets"), zodValidate(createBucketSchema), async (req, res) => {
  let { name, description, parentId } = req.body;
  try {
    const bucketId = await createStorageBucket({
      userId: req.project.userId,
      projectCode: req.project.code,
      data: { name, description, parentId },
    });

    if (!bucketId) throw Error("Couldn't create a bucket");
    const doc = await getBucketById({
      userId: req.project.userId,
      projectCode: req.project.code,
      id: bucketId,
    });
    sendStorageSocketEvent({
      projectCode: req.project.code,
      add: [doc],
    });
    return res.status(200).json(doc);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.put("/buckets/:bucketId", storageGuard("update", "buckets", loadBucket), zodValidate(updateBucketSchema), async (req, res) => {
  const { bucketId } = req.params;
  const { name, description } = req.body;
  if (!ObjectId.isValid(bucketId))
    return res.status(400).json({ message: "BucketId is not valid" });
  try {
    await updateBucket({
      userId: req.project.userId,
      projectCode: req.project.code,
      bucketId: bucketId,
      newData: { name, description },
    });
    const doc = await getBucketById({
      userId: req.project.userId,
      projectCode: req.project.code,
      id: bucketId,
    });
    sendStorageSocketEvent({
      projectCode: req.project.code,
      update: [doc],
    });
    return res.status(200).json({ message: "Bucket was updated successfully" });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.delete("/buckets/:bucketId", storageGuard("delete", "buckets", loadBucket), async (req, res) => {
  const { bucketId } = req.params;
  if (!ObjectId.isValid(bucketId))
    return res.status(400).json({ message: "BucketId is not valid" });
  try {
    const result = await deleteBucket({
      userId: req.project.userId,
      projectCode: req.project.code,
      bucketId: bucketId,
    });
    sendStorageSocketEvent({
      projectCode: req.project.code,
      delete: [bucketId],
    });
    return res.status(200).json({ message: "Bucket was deleted successfully" });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// update file metadata (rename, toggle public/private)
router.put("/files/:fileId", storageGuard("update", "files", loadFile), zodValidate(updateFileSchema), async (req, res) => {
  const { fileId } = req.params;
  if (!ObjectId.isValid(fileId))
    return res.status(400).json({ message: "fileId is not valid" });
  const { name, isPublic } = req.body;
  const newData = {};
  if (typeof name === "string") newData.name = name;
  if (typeof isPublic === "boolean") newData.isPublic = isPublic;
  if (Object.keys(newData).length === 0)
    return res.status(400).json({ message: "Nothing to update" });
  try {
    await updateFile({
      userId: req.project.userId,
      projectCode: req.project.code,
      fileId,
      newData,
    });
    const doc = await getFileById({
      userId: req.project.userId,
      projectCode: req.project.code,
      id: fileId,
    });
    sendStorageSocketEvent({
      projectCode: req.project.code,
      update: [doc],
    });
    return res.status(200).json({ message: "File was updated successfully" });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.delete("/files/:fileId", storageGuard("delete", "files", loadFile), async (req, res) => {
  const { fileId } = req.params;
  if (!ObjectId.isValid(fileId))
    return res.status(400).json({ message: "fileId is not valid" });
  try {
    await deleteFile({
      userId: req.project.userId,
      projectCode: req.project.code,
      fileId: fileId,
    });
    sendStorageSocketEvent({
      projectCode: req.project.code,
      delete: [fileId],
    });
    return res.status(200).json({ message: "File was deleted successfully" });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// public
router.get("/:fileId/:filename", async (req, res, next) => {
  try {
    const { fileId, filename } = req.params;
    let { token, size } = req.query;

    const file = await getStorageFile(req.project.code, fileId);
    // Compared with normalization applied: the same Arabic (or accented) name
    // can arrive as NFC or NFD depending on the client that uploaded it, and a
    // byte comparison rejects the file as "not found".
    if (!file || !sameFileName(`${file.name}.${file.ext}`, filename))
      return res.status(404).json({ message: "File not found!" });

    if (!file.isPublic && !req.isDbAdmin) {
      if (!token)
        return res.status(403).json({ message: "Access Denied!" });
      const decoded = verifyToken(token);
      if (!decoded || decoded.expired || decoded.project !== req.project.code)
        return res.status(403).json({ message: "Invalid or expired token!" });

      // If the project defines a storage rule covering file reads, enforce it on
      // the download too (per-file access control), so a project isn't limited to
      // "any logged-in user can read any private file". When no files read-rule is
      // defined, the valid-project-token check above remains the gate (backward
      // compatible). Admins bypass (handled by the outer !req.isDbAdmin).
      const sr = req.project.storageRules || {};
      const fileRuleDefined =
        Object.prototype.hasOwnProperty.call(sr, "/files") ||
        Object.prototype.hasOwnProperty.call(sr, "/files/[id]") ||
        (file._id && Object.prototype.hasOwnProperty.call(sr, `/files/${file._id}`));
      if (fileRuleDefined) {
        let user = null;
        if (decoded.userId) {
          user = await getDocument({
            userId: req.project.userId,
            projectCode: req.project.code,
            collectionName: authCollectionName,
            query: { _id: decoded.userId },
            select: { password: 0, resetPasswordToken: 0 },
          });
        }
        const allowed = await checkStorageRule({
          storageRules: sr,
          action: "read",
          resource: "files",
          user,
          doc: file,
        });
        if (!allowed)
          return res.status(403).json({ message: "Access denied by storage rules." });
      }
    }

    // Guard against path traversal: ensure file.dir resolves inside the uploads base.
    const resolvedDir = path.resolve(process.cwd(), file.dir);
    if (!resolvedDir.startsWith(UPLOADS_BASE + path.sep) && resolvedDir !== UPLOADS_BASE) {
      Logger.error("Path traversal attempt blocked", { fileId, dir: file.dir });
      return res.status(403).json({ message: "Access Denied!" });
    }

    if (
      size &&
      isImg(`${file.name}.${file.ext}`) &&
      ["small", "medium", "large"].includes(size)
    ) {
      try {
        await getResizedImage(file.dir, file.ext, size);
      } catch (error) {
        Logger.error("Image resize failed: " + error.message, { fileId, size });
        return res.status(404).json({ message: "File not found!" });
      }
    } else size = `org`;

    // Defense against stored-XSS: never let a stored file render as active content
    // on the API origin. Images/PDFs may display inline; everything else is forced
    // to download. nosniff stops the browser from MIME-sniffing into HTML/JS.
    const ext = String(file.ext || "").toLowerCase();
    const disposition = uploadLimits.inlineExtensions.has(ext) ? "inline" : "attachment";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      contentDisposition(disposition, `${file.name}.${file.ext}`)
    );

    const fullPath = path.join(resolvedDir, `${size}.${file.ext}`);
    return res.status(200).sendFile(fullPath);
  } catch (error) {
    // Express 4 does not forward rejections from async handlers, so anything
    // thrown past this point would leave the request open forever instead of
    // answering. Hand it to the central error handler.
    return next(error);
  }
});

module.exports = router;
