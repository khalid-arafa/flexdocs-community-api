const {
  filesCollectionName,
  bucketsCollectionName,
  systemProjectCode,
  systemProjectCollectionName,
  uploadsPath,
} = require("../constants");
const Logger = require("../utils/logger");
const {
  createDocument,
  getDocument,
  deleteDocument,
  getManyDocuments,
  updateDocument,
  countDocuments,
} = require("./db_service");
const { ObjectId } = require("mongodb");
const fs = require("fs");

async function createStorageFile({
  userId,
  projectCode,
  bucket,
  fileInfo,
  uploadedBy = null,
}) {
  try {
    let bucketObj;
    if (bucket) {
      if (ObjectId.isValid(bucket)) {
        bucketObj = await getBucketById({ userId, projectCode, id: bucket });
      } else {
        bucketObj = await getBucketByName({
          userId,
          projectCode,
          bucketName: bucket,
        });
      }
    }

    const file = {
      _id: { $oid: fileInfo._id },
      bucketId: bucketObj?._id || null,
      name: fileInfo.name,
      type: "file",
      ext: fileInfo.ext,
      size: fileInfo.size,
      projectCode,
      dir: fileInfo.dir,
      // Honor the uploader's choice; default to public for backward compat.
      isPublic: typeof fileInfo.isPublic === "boolean" ? fileInfo.isPublic : true,
      // Record the uploader so ownership-based storage rules are possible.
      uploadedBy: uploadedBy || null,
      accessedAt: new Date(),
    };
    const insertedId = await createDocument({
      userId,
      projectCode,
      collectionName: filesCollectionName,
      data: file,
    });
    // createDocument returns null on insert failure — treat that as an error
    // instead of reporting a file record that was never persisted.
    if (!insertedId) throw new Error("Failed to save the file record");
    file._id = file._id.$oid;
    file.type = "file";
    file.createdAt = new Date();
    return file;
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
    return false;
  }
}

async function getStorageFile(projectCode, fileId) {
  if (!ObjectId.isValid(fileId)) return null;
  const project = await getDocument({
    userId: "_system",
    projectCode: systemProjectCode,
    collectionName: systemProjectCollectionName,
    query: { code: projectCode },
    select: { code: 1, userId: 1 },
  });
  if (!project) return null;

  const file = await getDocument({
    userId: project.userId,
    projectCode: project.code,
    collectionName: filesCollectionName,
    query: { _id: fileId },
  });
  return file;
}

//
//
//

// Resolves a bucket by name, creating it on first use.
//
// The lookup is retried exactly ONCE after the create attempt, and that single
// re-read is what makes the concurrent case correct: two requests uploading to
// the same new bucket both miss and both try to create. The loser's insert
// fails — since createDocument propagates errors, that surfaces as a rejection
// (duplicate key) rather than a null return — so the create failure alone must
// NOT be fatal here. Re-reading resolves the loser to the bucket the winner
// actually created, rather than erroring on a bucket that now exists.
//
// A create failure with nothing to re-read means creation is genuinely broken,
// not raced, so retrying further cannot help — the previous version recursed
// unconditionally, which turned a persistently failing insert into infinite
// recursion that blew the stack and hung the request. Fail loudly instead, and
// surface the original insert error, which says why it actually failed.
async function getBucketByName({ userId, projectCode, bucketName, parentId }) {
  const findBucket = () =>
    getDocument({
      userId,
      projectCode,
      collectionName: bucketsCollectionName,
      query: { name: bucketName },
    });

  const existing = await findBucket();
  if (existing) return existing;

  let createError = null;
  try {
    await createDocument({
      userId,
      projectCode,
      collectionName: bucketsCollectionName,
      data: {
        name: bucketName,
        description: "Created automatically!",
        parentId: parentId ? new ObjectId(parentId) : null,
        isPublic: false,
        type: "bucket",
      },
    });
  } catch (error) {
    createError = error;
  }

  const bucket = await findBucket();
  if (bucket) return bucket;

  if (createError) throw createError;
  throw new Error(`Failed to create or resolve the bucket "${bucketName}"`);
}

async function createStorageBucket({ userId, projectCode, data }) {
  let bucket = await createDocument({
    userId,
    projectCode,
    collectionName: bucketsCollectionName,
    data: {
      type: "bucket",
      ...data,
    },
  });
  return bucket;
}

async function getBucketById({ userId, projectCode, id }) {
  let bucket = await getDocument({
    userId,
    projectCode,
    collectionName: bucketsCollectionName,
    query: { _id: id },
  });
  return bucket;
}

async function getFileById({ userId, projectCode, id }) {
  return await getDocument({
    userId,
    projectCode,
    collectionName: filesCollectionName,
    query: { _id: id },
  });
}

async function updateFile({ userId, projectCode, fileId, newData }) {
  return await updateDocument({
    userId,
    projectCode,
    collectionName: filesCollectionName,
    query: { _id: fileId },
    updateData: newData,
  });
}

async function updateBucket({ userId, projectCode, bucketId, newData }) {
  const result = await updateDocument({
    userId,
    projectCode: projectCode,
    collectionName: bucketsCollectionName,
    query: { _id: bucketId },
    updateData: newData,
  });
  return result;
}

async function deleteBucket({ userId, projectCode, bucketId }) {
  // getting bucket files
  const files = await getManyDocuments({
    userId: userId,
    projectCode,
    collectionName: filesCollectionName,
    query: { bucketId },
  });

  // deleting bucket document
  await deleteDocument({
    userId,
    projectCode,
    collectionName: bucketsCollectionName,
    query: { _id: bucketId },
  });

  // deleting bucket files
  for (let i = 0; i < files.length; i++) {
    await deleteFile({
      userId,
      projectCode,
      fileId: files[i]._id,
    });
  }

  // getting bucket contents of buckets
  const buckets = await getManyDocuments({
    userId,
    projectCode,
    collectionName: bucketsCollectionName,
    query: { parentId: bucketId },
  });

  // deleting buckets in bucket
  for (let i = 0; i < buckets.length; i++) {
    await deleteBucket({ userId, projectCode, bucketId: buckets[i]._id });
  }
}

async function deleteFile({ userId, projectCode, fileId }) {
  //  deleting file document
  await deleteDocument({
    userId,
    projectCode,
    collectionName: filesCollectionName,
    query: { _id: fileId },
  });
  // deleting the file from system
  try {
    const fileDirPath = `./${uploadsPath}/${projectCode}/${fileId.toString()}`;
    await fs.promises.rm(fileDirPath, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    Logger.error(error.message, { stack: error.stack });
  }
}

async function getBucketContent({
  userId,
  projectCode,
  bucketId,
  limit = 20,
  skip = 0,
}) {
  const bucketsCount = await countDocuments({
    userId,
    projectCode,
    collectionName: bucketsCollectionName,
    query: { parentId: bucketId },
  });

  let buckets = [];
  let files = [];

  if (skip < bucketsCount) {
    // Still have buckets to return
    const bucketsLimit = Math.min(limit, bucketsCount - skip);
    buckets = await getManyDocuments({
      userId,
      projectCode,
      collectionName: bucketsCollectionName,
      query: { parentId: bucketId },
      sort: { createdAt: -1 },
      skip,
      limit: bucketsLimit,
    });

    // If room left, get files too
    const remainingLimit = limit - buckets.length;

    if (remainingLimit > 0) {
      files = await getManyDocuments({
        userId,
        projectCode,
        collectionName: filesCollectionName,
        query: { bucketId },
        sort: { createdAt: -1 },
        skip: 0,
        limit: remainingLimit,
      });
    }
  } else {
    const fileSkip = skip - bucketsCount;
    files = await getManyDocuments({
      userId,
      projectCode,
      collectionName: filesCollectionName,
      query: { bucketId },
      sort: { createdAt: -1 },
      skip: fileSkip,
      limit,
    });
  }

  const filesCount = await countDocuments({
    userId,
    projectCode,
    collectionName: filesCollectionName,
    query: { bucketId },
  });

  return {
    totalCount: bucketsCount + filesCount,
    content: [...buckets, ...files],
  };
}

// search
async function searchBucketContent({
  userId,
  projectCode,
  bucketId,
  searchTerm,
  limit = 20,
  skip = 0,
}) {
  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escaped = escapeRegex(searchTerm);
  let query;
  if (searchTerm.includes(".")) {
    const [name, ext] = searchTerm.split(".");
    // Escape both halves before interpolating into $regex — otherwise a crafted
    // search term injects regex metacharacters (ReDoS / unintended matches).
    query = {
      name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
      ext: { $regex: `^${escapeRegex(ext)}$`, $options: "i" },
    };
  } else {
    query = {
      name: { $regex: escaped, $options: "i" },
    };
  }

  if (bucketId) query.bucketId = bucketId;

  const bucketsCount = await countDocuments({
    userId,
    projectCode,
    collectionName: bucketsCollectionName,
    query,
  });

  let buckets = [];
  let files = [];

  if (skip < bucketsCount) {
    const bucketsLimit = Math.min(limit, bucketsCount - skip);
    buckets = await getManyDocuments({
      userId,
      projectCode,
      collectionName: bucketsCollectionName,
      query,
      sort: { createdAt: -1 },
      skip,
      limit: bucketsLimit,
    });

    const remainingLimit = limit - buckets.length;
    if (remainingLimit > 0) {
      files = await getManyDocuments({
        userId,
        projectCode,
        collectionName: filesCollectionName,
        query,
        sort: { createdAt: -1 },
        skip: 0,
        limit: remainingLimit,
      });
    }
  } else {
    const fileSkip = skip - bucketsCount;
    files = await getManyDocuments({
      userId,
      projectCode,
      collectionName: filesCollectionName,
      query,
      sort: { createdAt: -1 },
      skip: fileSkip,
      limit,
    });
  }

  const filesCount = await countDocuments({
    userId,
    projectCode,
    collectionName: filesCollectionName,
    query,
  });

  return {
    totalCount: bucketsCount + filesCount,
    content: [...buckets, ...files],
  };
}

module.exports = {
  createStorageFile,
  getBucketContent,
  searchBucketContent,
  createStorageBucket,
  getStorageFile,
  getBucketByName,
  getBucketById,
  getFileById,
  updateBucket,
  updateFile,
  deleteBucket,
  deleteFile,
};
