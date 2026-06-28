const { getDocument } = require("../core/db_service");
const Logger = require("../utils/logger");
const { getIO } = require("./io_connect");
const { verifyToken } = require("../utils/encryptions");
const { authCollectionName } = require("../constants");
const {
  socketDocGuard,
  socketColGuard,
  socketAdminGuard,
} = require("../middleware/db_rules.middleware");

const watchingCollectionsUpdates = {};

function dbSockets(io) {
  io.on("connection", (socket) => {
    socket.on("set-user-token", async (data) => {
      if (!data) return delete socket.sender;
      const decodedUserToken = verifyToken(data);
      // Project binding: ignore tokens not minted for this project.
      if (
        !decodedUserToken ||
        decodedUserToken.expired ||
        decodedUserToken.project !== socket.project.code
      )
        return;
      const sender = await getDocument({
        userId: socket.project.userId,
        projectCode: socket.project.code,
        collectionName: authCollectionName,
        // tokens are signed as { userId, project } — match that field, not _id
        query: { _id: decodedUserToken.userId },
      });
      socket.sender = sender;
    });

    // watching document
    socket.on("watch-doc", async (data) => {
      try {
        socketDocGuard(socket, data, async () => {
          const col = data.path.split("/")[1];
          const docId = data.path.split("/")[2];
          if (!col || !docId) return;
          const doc = await getDocument({
            userId: socket.project.userId,
            projectCode: socket.project.code,
            collectionName: col,
            query: { _id: docId },
          });
          if (!doc) return socket.emit(docId, { action: "delete" });
          socket.join(doc._id.toString());
          socket.emit(doc._id, { action: "update", doc });
        });
      } catch (error) {
        Logger.error(error.message, { stack: error.stack });
      }
    });

    // watch collections (for admin)
    socket.on("watch-collections", async (data) => {
      socketAdminGuard(socket, async () => {
        const colPath = `${socket.project.code}/collections`;
        addWatching(watchingCollectionsUpdates, socket.id, colPath, data);
      });
    });

    // watching collection updates
    socket.on("watch-col-updates", async (data) => {
      socketColGuard(socket, data.col, async () => {
        const colPath = `${socket.project.code}/${data.col}`;
        addWatching(watchingCollectionsUpdates, socket.id, colPath, data);
      });
    });

    socket.on("disconnect", () => {
      delete watchingCollectionsUpdates[socket.id];
    });
  });
}

// check if the document matches the query
function matchesQuery(doc, query) {
  return Object.entries(query).every(([key, value]) => doc[key] === value);
}

async function sendUpdateCollectionStreamEvent({ colPath, action, data }) {
  const items = Object.entries(watchingCollectionsUpdates).filter(([_, arr]) =>
    arr.some((item) => item.colPath === colPath),
  );
  if (items.length == 0) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const socketId = item[0];
    const values = item[1];
    if (values.query && !matchesQuery(data, values.query)) continue;
    getIO()
      .to(socketId)
      .emit(`update:${colPath}`, { [action]: data });
  }
}

function addWatching(list, socketId, colPath, data) {
  if (!list[socketId]) list[socketId] = [];
  const newItem = { colPath, ...data };
  const exists = list[socketId].some(
    (item) => JSON.stringify(item) === JSON.stringify(newItem),
  );
  if (!exists) list[socketId].push(newItem);
}

module.exports = {
  dbSockets,
  sendUpdateCollectionStreamEvent,
};
