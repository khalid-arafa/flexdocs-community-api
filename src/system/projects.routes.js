const express = require("express");
const { systemApiAuth } = require("../middleware/system_auth.middleware");
const {
  createDocument,
  getDocument,
  getManyDocuments,
  deleteDocument,
  updateDocument,
  dropDatabase,
  countDocuments,
} = require("../core/db_service");
const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
  uploadsPath,
} = require("../constants");
const { projectApiAuth } = require("../middleware/project_auth.middleware");
const router = express.Router();
const fs = require("fs");
const { generateProjectCreds } = require("../utils/helper");
const { ObjectId } = require("mongodb");
const { defaultAuthRules } = require("../constants");
const { validateDbRulesStructure, validateAuthRules } = require("../utils/validators");
const { zodValidate } = require("../middleware/zod_validate.middleware");
const { createProjectSchema, createCredentialSchema } = require("../utils/schemas");
const Logger = require("../utils/logger");

router.use(systemApiAuth);

router.get("/", async (req, res) => {
  try {
    const projects = await getManyDocuments({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { userId: { $oid: req.sender._id } },
    });
    return res.status(200).json({ projects });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.post("/", zodValidate(createProjectSchema), async (req, res) => {
  const { name, code, description, isPublic } = req.body;
  try {
    const exists = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code },
    });
    if (exists)
      return res.status(400).json({
        message: "A project already exists with this code, try another one!",
      });

    const project = {
      name,
      code,
      // Default to PRIVATE. `isPublic || true` was always true, so a project
      // could never be created private. Honour an explicit boolean; otherwise
      // default false so a new project requires a project token by default.
      isPublic: typeof isPublic === "boolean" ? isPublic : false,
      isActive: true,
      description,
      userId: { $oid: req.sender._id },
      credentials: [],
    };

    const insertedId = await createDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      data: project,
    });

    return res.status(200).json({ _id: insertedId });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// check code if available
router.get("/check-code/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const exists = await countDocuments({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code },
    });
    return res.status(200).json({ success: exists == 0 });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// add project
router.post("/:projectCode", projectApiAuth, async (req, res) => {
  const { select } = req.body;
  try {
    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { userId: { $oid: req.sender._id }, code: req.params.projectCode },
      select,
    });
    if (!project)
      return res.status(404).json({ message: "Couldn't find your project!" });
    return res.status(200).json(project);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// Fields a client is allowed to change on a project. Whitelisting prevents
// mass assignment of server-managed fields like userId, code, credentials,
// projectToken hashes, or _id via an unfiltered req.body.
const PROJECT_UPDATABLE_FIELDS = [
  "name",
  "description",
  "isActive",
  "isPublic",
  "allowedOrigins",
  "dbRules",
  "storageRules",
  "authRules",
];

router.put("/:projectCode", projectApiAuth, async (req, res) => {
  try {
    const query = req.byAdmin
      ? { code: req.params.projectCode }
      : { userId: { $oid: req.sender._id }, code: req.params.projectCode };

    const updateData = {};
    for (const field of PROJECT_UPDATABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updateData[field] = req.body[field];
      }
    }
    if (Object.keys(updateData).length === 0)
      return res.status(400).json({ message: "No updatable fields provided" });

    const result = await updateDocument({
      userId: req.project.userId,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query,
      type: "update",
      updateData,
    });
    return res.status(200).json({ success: result.matchedCount > 0 });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(500).json({ message: error.message });
  }
});

// get project by code
router.get("/:projectCode", projectApiAuth, async (req, res) => {
  try {
    const creds = generateProjectCreds(req);
    creds.isPublic = req.project.isPublic;
    return res.status(200).json(creds);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});

router.delete("/:projectCode", projectApiAuth, async (req, res) => {
  const { projectCode } = req.params;
  try {
    const query = req.byAdmin
      ? { code: projectCode }
      : { userId: { $oid: req.sender._id }, code: projectCode };
    const result = await deleteDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query,
    });
    if (result.deletedCount) {
      await dropDatabase({
        userId: req.project.userId,
        projectCode: req.project.code,
      });
      await fs.promises.rm(`${uploadsPath}/${projectCode}`, {
        recursive: true,
        force: true,
      });
      return res.status(200).json({ success: true });
    }
    throw Error("Error has happened while deleting your project");
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// project creds
// add
router.get("/:projectCode/creds", projectApiAuth, async (req, res) => {
  try {
    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
    });
    return res.status(200).json(project.credentials);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});
router.post("/:projectCode/creds", projectApiAuth, zodValidate(createCredentialSchema), async (req, res) => {
  try {
    const { name, description } = req.body;

    // check if name exists
    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
    });
    if (project.credentials.find((i) => i.name == name)) {
      return res
        .status(400)
        .json({ message: "Credentials with this name already exsists" });
    }

    const generated = generateProjectCreds(req);
    const plaintextToken = generated.projectToken;

    const storedCreds = {
      projectId: generated.projectId,
      name: generated.name,
      code: generated.code,
      projectToken: plaintextToken,
      projectTokenHash: generated.projectTokenHash,
      url: generated.url,
    };

    const newCreds = {
      _id: new ObjectId(),
      name,
      description: description ?? "",
      creds: storedCreds,
      createdAt: new Date(),
    };

    const result = await updateDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
      updateData: {
        credentials: [...project.credentials, newCreds],
      },
    });

    if (result.modifiedCount == 0)
      throw Error("A problem has happened while generating your credentials");

    return res.status(200).json(newCreds);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});

router.delete("/:projectCode/creds/:id", projectApiAuth, async (req, res) => {
  try {
    // check if name exists
    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
    });
    if (
      project.credentials.filter((i) => i._id.toString() == req.params.id)
        .length == 0
    ) {
      return res
        .status(400)
        .json({ message: "Credentials with this name doesn't exsists" });
    }

    const result = await updateDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
      updateData: {
        credentials: [
          ...project.credentials.filter(
            (i) => i._id.toString() != req.params.id,
          ),
        ],
      },
    });

    if (result.modifiedCount == 0)
      throw Error("A problem has happened while genreating your credentials");

    return res.status(200).json({ success: true });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});
//

//

// rules
router.get("/:projectCode/db/rules", projectApiAuth, async (req, res) => {
  try {
    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
      select: { dbRules: 1 },
    });
    if (!project) throw new Error("Project not found!");
    return res.status(200).json(project.dbRules || {});
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});

router.put("/:projectCode/db/rules", projectApiAuth, async (req, res) => {
  try {
    const { valid, errors } = validateDbRulesStructure(req.body);
    if (!valid) {
      return res.status(400).json({ message: "Invalid rules structure", errors });
    }

    const query = await updateDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
      updateData: { dbRules: req.body },
    });
    let result = { message: "Project database rules modified successfully" };
    if (query.matchedCount > 0)
      result = { message: "No changes made, but document exists" };
    if (query.modifiedCount > 0)
      result = { message: "Document updated successfully" };
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.get("/:projectCode/storage/rules", projectApiAuth, async (req, res) => {
  try {
    return res.status(200).json(req.project.storageRules || {});
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

router.put("/:projectCode/storage/rules", projectApiAuth, async (req, res) => {
  try {
    const { valid, errors } = validateDbRulesStructure(req.body);
    if (!valid) {
      return res.status(400).json({ message: "Invalid storage rules structure", errors });
    }

    const query = await updateDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
      updateData: { storageRules: req.body },
    });
    let result = { message: "Project storage rules modified successfully" };
    if (query.matchedCount > 0)
      result = { message: "No changes made, but document exists" };
    if (query.modifiedCount > 0)
      result = { message: "Document updated successfully" };
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

// auth rules
router.get("/:projectCode/auth/rules", projectApiAuth, async (req, res) => {
  try {
    const project = await getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
      select: { authRules: 1 },
    });
    if (!project) throw new Error("Project not found!");
    return res.status(200).json(project.authRules || defaultAuthRules);
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return res.status(400).json({ message: error.message });
  }
});

router.put("/:projectCode/auth/rules", projectApiAuth, async (req, res) => {
  try {
    const { valid, errors } = validateAuthRules(req.body);
    if (!valid) {
      return res.status(400).json({ message: "Invalid auth rules", errors });
    }

    const query = await updateDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: req.project.code },
      updateData: { authRules: req.body },
    });
    let result = { message: "Project auth rules modified successfully" };
    if (query.matchedCount > 0)
      result = { message: "No changes made, but document exists" };
    if (query.modifiedCount > 0)
      result = { message: "Document updated successfully" };
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

module.exports = router;
