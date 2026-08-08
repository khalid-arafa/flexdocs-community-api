const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const Logger = require("../utils/logger");

const {
  getManyDocuments,
  createDocument,
  updateDocument,
  deleteDocument,
  getDocument,
  updateManyDocuments,
  deleteManyDocuments,
  getCollectionsList,
  countDocuments,
  createCollection,
  dropCollection,
  renameCollection,
} = require("../core/db_service");
const {
  sendUpdateCollectionStreamEvent,
  sendUpdateDocumentStreamEvent,
} = require("../sockets/db.sockets");
const {
  collectionMiddleware,
  documentMiddleware,
  bulkMiddleware,
} = require("../middleware/db_rules.middleware");
const { zodValidate } = require("../middleware/zod_validate.middleware");
const { pagination } = require("../constants");
const {
  listCollectionsSchema,
  createCollectionSchema,
  renameCollectionSchema,
  queryDocumentsSchema,
  updateManySchema,
  deleteManySchema,
} = require("../utils/schemas");

// Listing every collection (names + counts) is schema introspection — an
// admin/dashboard operation. Gate it behind the DB admin like rename/drop;
// otherwise a public project leaks its full schema to anonymous callers.
router.post("/collections", zodValidate(listCollectionsSchema), async (req, res) => {
  if (!req.isDbAdmin)
    return res.status(403).json({ message: "Access denied" });
  let { where, page, limit } = req.body;
  if (!page) page = pagination.defaultPage;
  if (!limit) limit = pagination.defaultLimit;
  limit = Math.min(Math.max(1, limit), pagination.maxLimit);
  const skip = (page - 1) * limit;
  try {
    let result = await getCollectionsList({
      userId: req.project.userId,
      projectCode: req.project.code,
      where,
      skip,
      limit,
    });
    return res.status(201).json({
      collections: result.collections,
      page,
      ipp: limit,
      totalCount: result.totalCount,
    });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// Explicit collection creation is an admin/dashboard operation (the data plane
// auto-creates collections on first insert under DB rules). Gate it behind the
// DB admin so anonymous callers on a public project can't spam collections.
router.post("/collections/new", zodValidate(createCollectionSchema), async (req, res) => {
  if (!req.isDbAdmin)
    return res.status(403).json({ message: "Access denied" });
  let { name } = req.body;
  try {
    const result = await createCollection({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: name,
    });
    if (result.success) {
      const colPath = `${req.project.code}/collections`;
      sendUpdateCollectionStreamEvent({
        colPath,
        action: "add",
        data: [{ name, documentsCount: 0 }],
        project: req.project,
      });
      return res.status(201).json({ success: true });
    }
    return res.status(400).json({ message: result.error });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

router.put("/collections/:col/rename", zodValidate(renameCollectionSchema), async (req, res) => {
  if (!req.isDbAdmin)
    return res.status(403).json({ message: "Access denied" });
  const oldName = req.params.col;
  const { newName } = req.body;
  try {
    const result = await renameCollection({
      userId: req.project.userId,
      projectCode: req.project.code,
      oldName,
      newName,
    });
    if (!result.success)
      return res.status(400).json({ message: result.error });

    const colPath = `${req.project.code}/collections`;
    const collectionResults = await getCollectionsList({
      userId: req.project.userId,
      projectCode: req.project.code,
      where: { name: newName },
      limit: 1,
    });
    const renamedCol = collectionResults.collections[0] || { name: newName, documentsCount: 0 };
    sendUpdateCollectionStreamEvent({ colPath, action: "delete", data: [{ name: oldName }], project: req.project });
    sendUpdateCollectionStreamEvent({ colPath, action: "add", data: [renamedCol], project: req.project });

    return res.status(200).json({ success: true });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

//

// get documents by body params
router.get("/:col", collectionMiddleware, (req, res) =>
  res.status(400).json({
    message: "Use post method with body params to get documents",
  }),
);
router.post("/:col", collectionMiddleware, zodValidate(queryDocumentsSchema), async (req, res) => {
  let { query, sort, select, limit, page, skip } = req.body;
  if (!page) page = pagination.defaultPage;
  if (!limit) limit = 100;
  limit = Math.min(Math.max(1, limit), pagination.maxLimit);
  if (!skip) skip = (page - 1) * limit;

  try {
    const docs = await getManyDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      query,
      sort,
      select,
      limit,
      skip,
    });

    if (!req.isDbAdmin) return res.status(200).json(docs);
    const totalCount = await countDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      query,
    });
    return res.status(201).json({
      docs,
      totalCount,
      page,
      ipp: limit,
    });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});
// get documents filters
router.get("/:col/filters", collectionMiddleware, async (req, res) => {
  try {
    const samples = await getManyDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      limit: 100,
    });
    const fields = new Set();
    samples.forEach((doc) => {
      Object.keys(doc).forEach((key) => fields.add(key));
    });

    return res.status(200).json({ fields: Array.from(fields) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// add document to a collection
router.post("/:col/add", collectionMiddleware, async (req, res) => {
  try {
    const collectionResults = await getCollectionsList({
      userId: req.project.userId,
      projectCode: req.project.code,
      where: { name: req.params.col },
      limit: 1,
    });
    const _id = await createDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      data: req.body,
    });

    if (collectionResults.collections.length === 0) {
      sendUpdateCollectionStreamEvent({
        colPath: `${req.project.code}/collections`,
        action: "add",
        data: [{ name: req.params.col, documentsCount: 1 }],
        project: req.project,
      });
    } else {
      const { name, documentsCount } = collectionResults.collections[0];
      sendUpdateCollectionStreamEvent({
        colPath: `${req.project.code}/collections`,
        action: "update",
        data: [{ name, documentsCount: documentsCount + 1 }],
        project: req.project,
      });
    }

    const colPath = `${req.project.code}/${req.params.col}`;
    sendUpdateCollectionStreamEvent({
      colPath,
      action: "add",
      data: [{ _id, ...req.body, createdAt: new Date() }],
      project: req.project,
    });

    return res.status(200).json({ _id });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// update documents by body params
router.put("/:col", bulkMiddleware, zodValidate(updateManySchema), async (req, res) => {
  const { filter, newData } = req.body;
  try {
    const query = await updateManyDocuments(
      req.project.userId,
      req.project.code,
      req.params.col,
      filter,
      newData,
    );
    let result = { code: 404, message: "Document not found" };
    if (query.matchedCount > 0)
      result = { code: 200, message: "No changes made, but documents exists" };
    if (query.modifiedCount > 0)
      result = { code: 200, message: "Documents were updated successfully" };
    return res.status(result.code).json({ message: result.message });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// delete documents by body params
router.delete("/:col", bulkMiddleware, zodValidate(deleteManySchema), async (req, res) => {
  const { filter } = req.body;
  if (!filter && !req.isDbAdmin)
    return res.status(400).json({ message: "filter is required!" });
  try {
    const query = await deleteManyDocuments({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: req.params.col,
      query: filter || {},
    });
    let result = { code: 404, message: "Documents not found" };
    if (query.deletedCount > 0) {
      result = { code: 200, message: "Documents were deleted successfully" };
    }
    if (req.isDbAdmin && !filter) {
      dropCollection({
        userId: req.project.userId,
        projectCode: req.project.code,
        collectionName: req.params.col,
      });
      sendUpdateCollectionStreamEvent({
        colPath: `${req.project.code}/collections`,
        action: "delete",
        data: [{ name: req.params.col }],
        project: req.project,
      });
      return res
        .status(200)
        .json({ message: "Collection was deleted successfully" });
    }
    return res.status(result.code).json({ message: result.message });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// get document by id
router.get("/:col/:id", documentMiddleware, async (req, res) => {
  const { col, id } = req.params;
  if (!ObjectId.isValid(id))
    return res.status(400).json({ message: "id is not valid" });
  try {
    // documentMiddleware already fetched this exact document (same {_id: id}
    // query) to run the rules check, and left it on req.document. Reuse it
    // instead of hitting Mongo again. req.document is only ever undefined
    // here on the req.isDbAdmin/req.byAdmin path, where documentMiddleware
    // skips the fetch entirely — fall back to fetching it ourselves then.
    const doc = req.document !== undefined ? req.document : await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: col,
      query: { _id: id },
    });
    if (!doc) return res.status(404).json({ message: "Doc not found!" });
    return res.status(200).json(doc);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// update document
router.put("/:col/:id", documentMiddleware, async (req, res) => {
  const { col, id } = req.params;
  if (!ObjectId.isValid(id))
    return res.status(400).json({ message: "id is not valid" });

  const { data, type } = req.body;
  if (data?._id) delete data._id;

  try {
    const query = await updateDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: col,
      query: { _id: new ObjectId(id) },
      updateData: data,
      type,
    });
    let result = { code: 404, message: "Document not found" };
    if (query.matchedCount > 0)
      result = { code: 200, message: "No changes made, but document exists" };
    if (query.modifiedCount > 0)
      result = { code: 200, message: "Document updated successfully" };

    const doc = await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: col,
      query: { _id: id },
    });
    // watch-doc joins a room named after the raw document id, not tracked in
    // watchingCollectionsUpdates, so this can't reuse the per-socket watch
    // registry sendUpdateCollectionStreamEvent walks below — see
    // sendUpdateDocumentStreamEvent's own comment in db.sockets.js for how it
    // handles the flag.
    sendUpdateDocumentStreamEvent({ project: req.project, col, room: id, action: "update", doc });

    const colPath = `${req.project.code}/${req.params.col}`;
    sendUpdateCollectionStreamEvent({ colPath, action: "update", data: [doc], project: req.project });

    return res.status(result.code).json({ message: result.message });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// delete document
router.delete("/:col/:id", documentMiddleware, async (req, res) => {
  const { col, id } = req.params;
  if (!ObjectId.isValid(id))
    return res.status(400).json({ message: "id is not valid" });
  try {
    // Same dedup as GET /:col/:id above — reuse the document documentMiddleware
    // already fetched for the rules check; only re-fetch when it's undefined
    // (the req.isDbAdmin/req.byAdmin path, where that fetch was skipped).
    const doc = req.document !== undefined ? req.document : await getDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: col,
      query: { _id: id },
    });
    if (!doc) return res.status(404).json({ message: "Document not found" });
    const query = await deleteDocument({
      userId: req.project.userId,
      projectCode: req.project.code,
      collectionName: col,
      query: { _id: new ObjectId(id) },
    });

    let result = { code: 404, message: "Document not found" };
    if (query.deletedCount > 0) {
      result = { code: 200, message: "Document was deleted successfully" };
      const colPath = `${req.project.code}/${req.params.col}`;
      sendUpdateDocumentStreamEvent({ project: req.project, col, room: id, action: "delete", doc });
      sendUpdateCollectionStreamEvent({
        colPath,
        action: "delete",
        data: [doc],
        project: req.project,
      });

      const collectionResults = await getCollectionsList({
        userId: req.project.userId,
        projectCode: req.project.code,
        where: { name: req.params.col },
        limit: 1,
      });
      sendUpdateCollectionStreamEvent({
        colPath: `${req.project.code}/collections`,
        action: "update",
        data: [collectionResults.collections[0]],
        project: req.project,
      });
    }

    return res.status(result.code).json({ message: result.message });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
