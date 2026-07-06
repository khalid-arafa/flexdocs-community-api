const path = require("path");
const fs = require("fs");
const { ObjectId } = require("mongodb");
const { createStorageFile } = require("../core/storage_service");
const { getDownloadableLink } = require("../utils/file");
const { uploadsPath, uploadLimits } = require("../constants");
const { getIO } = require("./io_connect");
const { checkStorageRule } = require("../middleware/storage_rules.middleware");
const Logger = require("../utils/logger");

const files_room = {};

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
        // files. With no rules defined this allows uploads (backward compatible).
        const allowed = await checkStorageRule({
          storageRules: socket.project.storageRules,
          action: "add",
          resource: "files",
          user: socket.sender || null,
          body: fileInfo,
        });
        if (!allowed) {
          return socket.emit("upload:error", {
            name: fileInfo.name,
            message: "Upload denied by storage rules",
          });
        }

        const _id = new ObjectId();
        const dir = path.join(`${uploadsPath}`, socket.project.code, `${_id}`);
        fs.mkdirSync(dir, { recursive: true });

        socket.activeUploads[fileInfo.name] = {
          fileInfo: { ...fileInfo, _id, ext, dir },
          filePath: path.join(dir, `org.${ext}`),
          bytesReceived: 0,
        };

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
        upload.bytesReceived = (upload.bytesReceived || 0) + buf.length;
        if (upload.bytesReceived > uploadLimits.maxFileSize) {
          try { fs.unlinkSync(upload.filePath); } catch {}
          try { fs.rmdirSync(path.dirname(upload.filePath)); } catch {}
          delete socket.activeUploads[name];
          return socket.emit("upload:error", {
            name,
            message: `File exceeds maximum size of ${uploadLimits.maxFileSize / 1024 / 1024}MB`,
          });
        }

        fs.appendFileSync(upload.filePath, buf);
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

    socket.on("upload:done", async (name) => {
      const upload = socket.activeUploads[name];
      if (!upload) return;

      try {
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
        socket.emit("upload:complete", {
          name: name,
          filename: path.basename(upload.filePath),
          url: link,
          size: fs.statSync(upload.filePath).size,
        });

        sendStorageSocketEvent({
          projectCode: socket.project.code,
          add: [fileDoc],
        });

        // Clean up
        delete socket.activeUploads[name];
      } catch (error) {
        Logger.error(error.message, { stack: error.stack });
        socket.emit("upload:error", {
          name,
          message: "Failed to complete upload",
        });
        delete socket.activeUploads[name];
      }
    });

    // storage for admin
    socket.on("watch-buckets", async (data) => {
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
      // Clean up any in-progress uploads
      for (const name of Object.keys(socket.activeUploads)) {
        const upload = socket.activeUploads[name];
        try { fs.unlinkSync(upload.filePath); } catch {}
        try { fs.rmdirSync(path.dirname(upload.filePath)); } catch {}
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
};
