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

async function getBucketByName({ userId, projectCode, bucketName, parentId }) {
  let bucket = await getDocument({
    userId,
    projectCode,
    collectionName: bucketsCollectionName,
    query: { name: bucketName },
  });
  if (!bucket) {
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
    return await getBucketByName({ userId, projectCode, bucketName, parentId });
  }
  return bucket;
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

  // console.log({
  //   params: {
  //     userId,
  //     projectCode,
  //     bucketId,
  //     limit,
  //     skip,
  //   },
  // });

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

  // console.log({
  //   buckets: buckets.map((i) => i.name),
  //   files: files.map((i) => i.name),
  // });

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
