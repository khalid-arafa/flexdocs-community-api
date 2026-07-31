const { getDocument } = require("../core/db_service");
const Logger = require("../utils/logger");
const { getIO } = require("./io_connect");
const { verifyToken } = require("../utils/encryptions");
const { authCollectionName, socketLimits } = require("../constants");
const {
  socketDocGuard,
  socketColGuard,
  socketAdminGuard,
} = require("../middleware/db_rules.middleware");

// socketId → Map<watchKey, { colPath, query }>
//
// A Map keyed by colPath+query replaces the previous array: dedup was an O(n)
// JSON.stringify comparison per subscribe, and entries were only ever appended.
const watchingCollectionsUpdates = {};

/** Order-independent key, so the same filter written two ways dedups. */
function watchKey(colPath, query) {
  if (!query) return colPath;
  const normalized = Object.keys(query)
    .sort()
    .map((key) => `${key}=${JSON.stringify(query[key])}`)
    .join("&");
  return `${colPath}|${normalized}`;
}

function normalizeQuery(data) {
  const query = data && data.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return undefined;
  return Object.keys(query).length > 0 ? query : undefined;
}

/** Returns false when the socket is already at its subscription ceiling. */
function addWatching(list, socketId, colPath, data) {
  let watches = list[socketId];
  if (!watches) {
    watches = new Map();
    list[socketId] = watches;
  }
  const query = normalizeQuery(data);
  const key = watchKey(colPath, query);
  if (watches.has(key)) return true;
  if (watches.size >= socketLimits.maxWatchesPerSocket) return false;
  watches.set(key, { colPath, query });
  return true;
}

/** Drops every watch this socket holds on `colPath`, whatever the filter. */
function removeWatching(list, socketId, colPath) {
  const watches = list[socketId];
  if (!watches) return;
  for (const [key, value] of watches) {
    if (value.colPath === colPath) watches.delete(key);
  }
  if (watches.size === 0) delete list[socketId];
}

function dbSockets(io) {
  io.on("connection", (socket) => {
    const subscribe = (colPath, data) => {
      if (!addWatching(watchingCollectionsUpdates, socket.id, colPath, data)) {
        socket.emit("error", {
          message: `Subscription limit reached (${socketLimits.maxWatchesPerSocket}); unwatch before watching more.`,
        });
      }
    };

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
          const room = doc._id.toString();
          socket.join(room);
          // Event name must be the string id the client subscribed with; an
          // ObjectId here would stringify inconsistently.
          socket.emit(room, { action: "update", doc });
        });
      } catch (error) {
        Logger.error(error.message, { stack: error.stack });
      }
    });

    // Both SDKs already emit an unwatch on teardown, but no handler existed, so
    // rooms and registry entries survived until disconnect. JS sends
    // `unwatch-doc` with { path }; Flutter sends `unwatch-doc-updates` with a
    // bare path string. Accept both shapes — older client builds are deployed.
    const unwatchDoc = (data) => {
      const path = typeof data === "string" ? data : data && data.path;
      if (!path) return;
      const docId = path.split("/")[2];
      if (docId) socket.leave(docId);
    };
    socket.on("unwatch-doc", unwatchDoc);
    socket.on("unwatch-doc-updates", unwatchDoc);

    // watch collections (for admin)
    socket.on("watch-collections", async (data) => {
      socketAdminGuard(socket, async () => {
        subscribe(`${socket.project.code}/collections`, data);
      });
    });

    const unwatchCollections = () => {
      removeWatching(
        watchingCollectionsUpdates,
        socket.id,
        `${socket.project.code}/collections`,
      );
    };
    socket.on("unwatch-collections", unwatchCollections);
    socket.on("stop-watch-collections", unwatchCollections);

    // watching collection updates
    socket.on("watch-col-updates", async (data) => {
      socketColGuard(socket, data.col, async () => {
        subscribe(`${socket.project.code}/${data.col}`, data);
      });
    });

    const unwatchCol = (data) => {
      const col = typeof data === "string" ? data : data && data.col;
      if (!col) return;
      removeWatching(
        watchingCollectionsUpdates,
        socket.id,
        `${socket.project.code}/${col}`,
      );
    };
    socket.on("unwatch-col-updates", unwatchCol);
    socket.on("stop-watch-col-updates", unwatchCol);

    socket.on("disconnect", () => {
      delete watchingCollectionsUpdates[socket.id];
    });
  });
}

/**
 * Equality match of a single document against a watch filter.
 *
 * Only the equality subset the client watch API accepts is supported. Mongo
 * ids arrive as ObjectId but are filtered against strings from the client, so
 * object-valued fields are compared by their string form.
 */
function matchesQuery(doc, query) {
  if (!doc || typeof doc !== "object") return false;
  return Object.entries(query).every(([key, value]) => {
    const field = doc[key];
    if (field == null) return field === value;
    if (typeof value === "string" && typeof field === "object")
      return String(field) === value;
    return field === value;
  });
}

async function sendUpdateCollectionStreamEvent({ colPath, action, data }) {
  const docs = Array.isArray(data) ? data : [data];
  if (docs.length === 0) return;

  for (const socketId of Object.keys(watchingCollectionsUpdates)) {
    const watches = [];
    for (const watch of watchingCollectionsUpdates[socketId].values()) {
      if (watch.colPath === colPath) watches.push(watch);
    }
    if (watches.length === 0) continue;

    // Previously the whole watch array was read as if it were a single entry,
    // so `.query` was always undefined and every subscriber received every
    // document regardless of the filter it asked for.
    //
    // One socket may hold several watches on the same collection under
    // different filters; they share a single event name, so it receives the
    // union of what those filters admit.
    const visible = watches.some((watch) => !watch.query)
      ? docs
      : docs.filter((doc) =>
          watches.some((watch) => matchesQuery(doc, watch.query)),
        );
    if (visible.length === 0) continue;

    getIO()
      .to(socketId)
      .emit(`update:${colPath}`, { [action]: visible });
  }
}

module.exports = {
  dbSockets,
  sendUpdateCollectionStreamEvent,
  // exported for tests
  __internals: {
    watchingCollectionsUpdates,
    addWatching,
    removeWatching,
    matchesQuery,
    watchKey,
  },
};
