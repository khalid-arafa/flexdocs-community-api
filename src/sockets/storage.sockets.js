const path = require("path");
const fsp = require("fs/promises");
const { ObjectId } = require("mongodb");
const { createStorageFile } = require("../core/storage_service");
const { getDownloadableLink } = require("../utils/file");
const { uploadsPath, uploadLimits } = require("../constants");
const { getIO } = require("./io_connect");
const { checkStorageRule } = require("../middleware/storage_rules.middleware");
const { isAdminSocket } = require("../middleware/db_rules.middleware");
const Logger = require("../utils/logger");

const files_room = {};

// Storage rules are default-DENY (core/db_rules_service `_evaluateRule`): a
// path with no rule defined is rejected, so a project that has authored no
// storage rules at all denies every non-admin upload. That is the intended
// posture — it matches DB rules and Firebase/Supabase, and it is what the REST
// download path enforces too — but a bare "denied" reads as a bug and sends
// operators hunting through rules that do not exist. Report the missing-config
// case in its own words instead.
function hasStorageRules(storageRules) {
  return Boolean(storageRules) && Object.keys(storageRules).length > 0;
}

const NO_STORAGE_RULES_UPLOAD_MESSAGE =
  "Upload denied: no storage rules are defined for this project. " +
  'Define a "/files" storage rule (for example {"/files": {"add": true}}) to allow uploads.';

/** Removes a partial upload's file and its directory, ignoring what is absent. */
async function discardUpload(upload) {
  try {
    await fsp.unlink(upload.filePath);
  } catch {}
  try {
    await fsp.rmdir(path.dirname(upload.filePath));
  } catch {}
}

/**
 * `upload:done` and `upload:cancel` carry a bare filename from the JS SDK and
 * a `{ name }` object from the Flutter SDK. Accept both: the server previously
 * indexed `activeUploads` with the object, so Flutter uploads were written to
 * disk in full and then silently never finalized.
 */
function uploadName(payload) {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload.name === "string") return payload.name;
  return undefined;
}

function storageSockets(io) {
  io.on("connection", (socket) => {
    Logger.info(`[storage] socket connected: ${socket.id}, project: ${socket.project?.code}`);
    socket.onAny((event, ...args) => {
      Logger.info(`[storage] event received: ${event} from ${socket.id}`);
    });
    // Track multiple uploads by filename
    socket.activeUploads = {};

    const MAX_CONCURRENT_UPLOADS = 10;

    // upload file
    socket.on("upload:start", async (fileInfo) => {
      Logger.info(`[storage] upload:start received: ${JSON.stringify(fileInfo)}`);
      try {
        // Reject if too many concurrent uploads for this socket
        if (Object.keys(socket.activeUploads).length >= MAX_CONCURRENT_UPLOADS) {
          return socket.emit("upload:error", {
            name: fileInfo?.name || "unknown",
            message: `Too many concurrent uploads (max ${MAX_CONCURRENT_UPLOADS})`,
          });
        }

        // Validate fileInfo
        if (!fileInfo || typeof fileInfo.name !== "string" || !fileInfo.name.trim()) {
          return socket.emit("upload:error", {
            name: fileInfo?.name || "unknown",
            message: "File name is required",
          });
        }

        // Reject path traversal attempts
        const basename = path.basename(fileInfo.name);
        if (basename !== fileInfo.name) {
          return socket.emit("upload:error", {
            name: fileInfo.name,
            message: "File name must not contain path separators",
          });
        }

        if (fileInfo.name.length > uploadLimits.maxFileNameLength) {
          return socket.emit("upload:error", {
            name: fileInfo.name,
            message: `File name must not exceed ${uploadLimits.maxFileNameLength} characters`,
          });
        }

        const ext = path.extname(fileInfo.name).toLowerCase().slice(1);
        if (uploadLimits.blockedExtensions.has(ext)) {
          return socket.emit("upload:error", {
            name: fileInfo.name,
            message: `File type .${ext} is not allowed`,
          });
        }

        if (fileInfo.size && fileInfo.size > uploadLimits.maxFileSize) {
          return socket.emit("upload:error", {
            name: fileInfo.name,
            message: `File size must not exceed ${uploadLimits.maxFileSize / 1024 / 1024}MB`,
          });
        }

        // Authorize the upload against the project's storage rules (action "add").
        // Closes the gap where any socket holding the project token could write
        // files. The check is default-DENY: a project with no "/files" add-rule
        // denies non-admin uploads (see hasStorageRules above), matching the
        // REST download path rather than quietly allowing everything.
        // Admin bypass mirrors storageGuard's `req.isDbAdmin || req.byAdmin` on
        // the REST side — without it the dashboard's own uploads could be
        // denied by rules written for ordinary end users.
        const allowed =
          (await isAdminSocket(socket)) ||
          (await checkStorageRule({
            storageRules: socket.project.storageRules,
            action: "add",
            resource: "files",
            user: socket.sender || null,
            body: fileInfo,
          }));
        if (!allowed) {
          const unconfigured = !hasStorageRules(socket.project.storageRules);
          if (unconfigured)
            Logger.warn(
              "[storage] upload denied: no storage rules are defined for the project",
              { projectCode: socket.project.code, file: fileInfo.name },
            );
          return socket.emit("upload:error", {
            name: fileInfo.name,
            message: unconfigured
              ? NO_STORAGE_RULES_UPLOAD_MESSAGE
              : "Upload denied by storage rules",
          });
        }

        const _id = new ObjectId();
        const dir = path.join(`${uploadsPath}`, socket.project.code, `${_id}`);

        const upload = {
          fileInfo: { ...fileInfo, _id, ext, dir },
          filePath: path.join(dir, `org.${ext}`),
          bytesReceived: 0,
          error: null,
          // Serializes every filesystem operation for this upload, starting
          // with directory creation. Registering the upload synchronously and
          // chaining off mkdir means a chunk arriving before the directory
          // exists is queued rather than dropped.
          writeChain: Promise.resolve(),
        };
        upload.writeChain = fsp.mkdir(dir, { recursive: true }).catch((error) => {
          upload.error = error;
        });

        socket.activeUploads[fileInfo.name] = upload;
        socket.emit("upload:ready", { name: fileInfo.name });
      } catch (error) {
        Logger.error(error.message, { stack: error.stack });
        socket.emit("upload:error", {
          name: fileInfo?.name || "unknown",
          message: "Failed to initiate upload",
        });
      }
    });

    socket.on("upload:chunk", ({ name, chunk }) => {
      try {
        const upload = socket.activeUploads[name];
        if (!upload) {
          return socket.emit("upload:error", {
            name,
            message: "No file upload initiated",
          });
        }

        const buf = Buffer.from(chunk);
        // Accounted synchronously so the size ceiling still holds regardless of
        // how far behind the write queue is.
        upload.bytesReceived = (upload.bytesReceived || 0) + buf.length;
        if (upload.bytesReceived > uploadLimits.maxFileSize) {
          upload.error = new Error("File exceeds maximum size");
          upload.writeChain = upload.writeChain.then(() => discardUpload(upload));
          delete socket.activeUploads[name];
          return socket.emit("upload:error", {
            name,
            message: `File exceeds maximum size of ${uploadLimits.maxFileSize / 1024 / 1024}MB`,
          });
        }

        // Appends are queued rather than awaited inline. socket.io delivers
        // chunks in order, but independently awaited writes would interleave
        // and corrupt the file; chaining preserves order without blocking the
        // event loop the way appendFileSync did — a single 50MB upload used to
        // stall every other request 800 times over.
        upload.writeChain = upload.writeChain.then(async () => {
          if (upload.error) return; // already failed — drop remaining chunks
          try {
            await fsp.appendFile(upload.filePath, buf);
          } catch (error) {
            upload.error = error;
          }
        });

        socket.emit("upload:progress", {
          name: name,
          received: true,
        });
      } catch (error) {
        Logger.error(error.message, { stack: error.stack });
        socket.emit("upload:error", {
          name,
          message: "Failed to write chunk",
        });
      }
    });

    socket.on("upload:done", async (payload) => {
      const name = uploadName(payload);
      const upload = name ? socket.activeUploads[name] : undefined;
      if (!upload) return;

      try {
        // Drain queued writes before reading the file back, and surface the
        // first write error rather than reporting a truncated file as complete.
        await upload.writeChain;
        if (upload.error) throw upload.error;

        upload.fileInfo.name = upload.fileInfo.name.replace(/\.[^/.]+$/, ""); // removing extension

        const fileDoc = await createStorageFile({
          userId: socket.project.userId,
          projectCode: socket.project.code,
          bucket: upload.fileInfo.bucket,
          fileInfo: upload.fileInfo,
          uploadedBy: socket.sender?._id ? socket.sender._id.toString() : null,
        });
        // createStorageFile returns false on failure — without this check the
        // client is told the upload completed even though no record exists.
        if (!fileDoc) throw new Error("Failed to save the uploaded file's record");

        const link = getDownloadableLink(fileDoc);
        const { size } = await fsp.stat(upload.filePath);
        socket.emit("upload:complete", {
          name: name,
          filename: path.basename(upload.filePath),
          url: link,
          size,
        });

        sendStorageSocketEvent({
          projectCode: socket.project.code,
          add: [fileDoc],
        });

        // Clean up
        delete socket.activeUploads[name];
      } catch (error) {
        Logger.error(error.message, { stack: error.stack });
        // The partial file is unreachable once the entry is dropped, so remove
        // it rather than leaving it to accumulate on disk.
        upload.error = upload.error || error;
        upload.writeChain.then(() => discardUpload(upload)).catch(() => {});
        socket.emit("upload:error", {
          name,
          message: "Failed to complete upload",
        });
        delete socket.activeUploads[name];
      }
    });

    // The JS SDK emits this when a caller aborts an upload. Without a handler
    // the partial file survived until the socket disconnected.
    socket.on("upload:cancel", (payload) => {
      const name = uploadName(payload);
      const upload = name ? socket.activeUploads[name] : undefined;
      if (!upload) return;
      upload.error = new Error("Upload cancelled");
      delete socket.activeUploads[name];
      upload.writeChain
        .then(() => discardUpload(upload))
        .catch((error) =>
          Logger.error("upload cancel cleanup failed: " + error.message, {
            stack: error.stack,
          }),
        );
      socket.emit("upload:cancelled", { name });
    });

    // storage for admin
    //
    // Opt-in rule check (C2), default OFF via project.storageRealtimeCheck:
    // historically this room had NO rule check at all — any socket holding a
    // valid project token, public or private, received every file event.
    // Gated behind a flag rather than always-on so existing deployments that
    // rely on the current unfiltered behavior don't regress until they opt in
    // and author storage rules for it, mirroring realtimePerDocCheck (K2).
    socket.on("watch-buckets", async (data) => {
      if (socket.project.storageRealtimeCheck) {
        const allowed =
          (await isAdminSocket(socket)) ||
          (await checkStorageRule({
            storageRules: socket.project.storageRules,
            action: "read",
            resource: "buckets",
            user: socket.sender || null,
          }));
        if (!allowed) return socket.emit("error", "Unauthorized");
      }
      addSocketToStorageRoom({
        projectCode: socket.project.code,
        id: socket.id,
      });
    });

    socket.on("stop-watch-buckets", async (data) => {
      removeStorageSocketFromRoom({
        projectCode: socket.project.code,
        id: socket.id,
      });
    });

    socket.on("disconnect", () => {
      // Clean up any in-progress uploads. Each discard is chained after that
      // upload's queued writes so cleanup cannot race a pending append and
      // leave the file behind.
      for (const name of Object.keys(socket.activeUploads)) {
        const upload = socket.activeUploads[name];
        upload.error = new Error("Socket disconnected");
        upload.writeChain
          .then(() => discardUpload(upload))
          .catch((error) =>
            Logger.error("upload cleanup failed: " + error.message, {
              stack: error.stack,
            }),
          );
      }
      socket.activeUploads = {};

      removeStorageSocketFromRoom({
        projectCode: socket.project.code,
        id: socket.id,
      });
    });
  });
}

// handling rooms
function getStorageRoomName(projectCode) {
  return `${projectCode}-storage`;
}

function getStorageSocketsByRoom(projectCode) {
  const name = getStorageRoomName(projectCode);
  if (name in files_room) return files_room[name];
  return [];
}

function addSocketToStorageRoom({ projectCode, id }) {
  const name = getStorageRoomName(projectCode);
  if (name in files_room) {
    if (files_room[name].includes(id)) return;
    files_room[name].push(id);
  } else files_room[name] = [id];
}

function removeStorageSocketFromRoom({ projectCode, id }) {
  const name = getStorageRoomName(projectCode);
  if (name in files_room && files_room[name].includes(id)) {
    files_room[name] = files_room[name].filter((i) => i !== id);
    if (files_room[name].length === 0) delete files_room[name];
  }
}

function sendStorageSocketEvent({
  projectCode,
  add,
  update,
  delete: deletedItems,
}) {
  const roomName = getStorageRoomName(projectCode);
  const socketIds = getStorageSocketsByRoom(projectCode);

  for (let i = 0; i < socketIds.length; i++) {
    getIO()
      .to(socketIds[i])
      .emit(roomName, { add, update, delete: deletedItems ?? null });
  }
}

module.exports = {
  storageSockets,
  sendStorageSocketEvent,
  // exported for tests
  __internals: {
    files_room,
    uploadName,
    discardUpload,
    hasStorageRules,
    NO_STORAGE_RULES_UPLOAD_MESSAGE,
    getStorageRoomName,
    getStorageSocketsByRoom,
    addSocketToStorageRoom,
    removeStorageSocketFromRoom,
  },
};
