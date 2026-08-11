const { getDocument } = require("../core/db_service");
const Logger = require("../utils/logger");
const { getIO } = require("./io_connect");
const { verifyToken } = require("../utils/encryptions");
const { authCollectionName, socketLimits } = require("../constants");
const {
  socketDocGuard,
  socketColGuard,
  socketAdminGuard,
  isAdminSocket,
} = require("../middleware/db_rules.middleware");
const DbRulesService = require("../core/db_rules_service");
const { changeStreamsActiveFor } = require("../core/realtime_source");

/**
 * Should this route-originated push be dropped because the change stream will
 * report the same write? (C6 — see core/change_streams.js.)
 *
 * Only document collections are handed over. `${code}/collections` is a pseudo
 * collection carrying collection-list and document-count changes, which the
 * oplog does not describe in that shape, so it stays route-driven always —
 * otherwise the dashboard's collection list would freeze the moment a project
 * enabled change streams.
 *
 * Pushes originating FROM the change stream are never suppressed, and neither
 * is anything when the stream isn't running, so a stream that dies falls back
 * to emit-after-write instead of going quiet.
 */
function supersededByChangeStream({ source, project, colPath }) {
  if (source === "change-stream") return false;
  if (!changeStreamsActiveFor(project)) return false;
  return colPath !== `${project.code}/collections`;
}

// socketId → Map<watchKey, { colPath, query }>
//
// A Map keyed by colPath+query replaces the previous array: dedup was an O(n)
// JSON.stringify comparison per subscribe, and entries were only ever appended.
//
// Since K3 this registry stores *filters only*. Subscriber discovery is done
// with real Socket.IO rooms (see colRoom/filteredRoom below) — a room can't
// carry a per-socket query, so both structures are needed, but the fan-out no
// longer walks this object to find out who is listening.
const watchingCollectionsUpdates = {};

/**
 * Room holding every socket with at least one watch on `colPath`.
 *
 * Prefixed so it can never collide with a `watch-doc` room, which is named
 * after a raw document id.
 */
function colRoom(colPath) {
  return `col:${colPath}`;
}

/**
 * Subset of `colRoom(colPath)` that needs an individually-built payload
 * because *every* watch it holds on this collection carries a filter.
 *
 * A socket holding both a filtered and an unfiltered watch is deliberately
 * NOT a member: an unfiltered watch already entitles it to the whole batch,
 * so it can take the single broadcast with everyone else.
 */
function filteredRoom(colPath) {
  return `colq:${colPath}`;
}

/**
 * Reconciles this socket's room membership for `colPath` with the watches it
 * currently holds. Called after every add and every remove, so membership is
 * derived state and can't drift out of sync with the registry.
 */
function syncWatchRooms(socket, colPath) {
  const watches = watchingCollectionsUpdates[socket.id];
  let holdsAny = false;
  let holdsUnfiltered = false;
  if (watches) {
    for (const watch of watches.values()) {
      if (watch.colPath !== colPath) continue;
      holdsAny = true;
      if (!watch.query) holdsUnfiltered = true;
    }
  }
  if (!holdsAny) {
    socket.leave(colRoom(colPath));
    socket.leave(filteredRoom(colPath));
    return;
  }
  socket.join(colRoom(colPath));
  if (holdsUnfiltered) socket.leave(filteredRoom(colPath));
  else socket.join(filteredRoom(colPath));
}

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
        // Rejected at the cap — leave room membership exactly as it was.
        return;
      }
      syncWatchRooms(socket, colPath);
    };

    const unsubscribe = (colPath) => {
      removeWatching(watchingCollectionsUpdates, socket.id, colPath);
      syncWatchRooms(socket, colPath);
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
      // Revocation check, mirroring socket_auth.middleware.js: a mismatch
      // between the token's tokenVersion claim and the user's current stored
      // value means the token was invalidated by a later /revoke-tokens call.
      // Treat it exactly like the invalid-token cases above and leave
      // socket.sender untouched. Absent claim/field both default to 0.
      const tokenVersion = decodedUserToken.tokenVersion || 0;
      if (!sender || (sender.tokenVersion || 0) !== tokenVersion) return;
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
      unsubscribe(`${socket.project.code}/collections`);
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
      unsubscribe(`${socket.project.code}/${col}`);
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

/**
 * Per-socket visibility check for realtime pushes (K2: opt-in per-document
 * dbRules re-check on push — see project.realtimePerDocCheck in
 * system/projects.routes.js). Shared by sendUpdateCollectionStreamEvent and
 * sendUpdateDocumentStreamEvent below so both pushes apply one rule.
 *
 * Admin sockets (the dashboard) always see the full batch — the same bypass
 * socketColGuard/socketDocGuard apply at subscribe time (db_rules.middleware.js),
 * kept in sync here so turning this flag on can never hide data from a
 * project's own admin dashboard, only from non-admin subscribers.
 *
 * For everyone else, each document is re-evaluated against the project's
 * CURRENT dbRules at the moment of push rather than only at subscribe time,
 * so a rule edit — or a document mutation that flips a JEXL predicate over
 * `doc`/`user` — takes effect on the very next push instead of waiting for
 * the client to unwatch/rewatch.
 *
 * Fails closed: DbRulesService.check() already denies on internal error, and
 * this try/catch extends that guarantee to the admin lookup itself — any
 * unexpected failure here must result in NOT sending, never in sending
 * unfiltered.
 */
async function filterVisibleDocsForSocket({ liveSocket, rulesService, col, docs }) {
  try {
    if (await isAdminSocket(liveSocket)) return docs;
    const results = await Promise.all(
      docs.map((doc) =>
        rulesService.check({
          action: "read",
          path: `/${col}/${doc && doc._id}`,
          user: liveSocket.sender || null,
          doc,
        }),
      ),
    );
    return docs.filter((_, i) => results[i]);
  } catch (error) {
    Logger.error("filterVisibleDocsForSocket error: " + error.message, { stack: error.stack });
    return [];
  }
}

/** Room members as a plain array; `[]` when the room doesn't exist. */
function roomMembers(io, room) {
  const members = io.sockets.adapter.rooms.get(room);
  return members ? [...members] : [];
}

/** The watches this socket holds on exactly this collection. */
function watchesOn(socketId, colPath) {
  const held = watchingCollectionsUpdates[socketId];
  if (!held) return [];
  const watches = [];
  for (const watch of held.values()) {
    if (watch.colPath === colPath) watches.push(watch);
  }
  return watches;
}

/**
 * Fan-out for a collection-level change.
 *
 * K3 moved subscriber discovery onto real Socket.IO rooms. Two things changed,
 * neither of them visible on the wire — the event name and payload shape are
 * identical to what this emitted before:
 *
 * - **Discovery** used to scan every socket in `watchingCollectionsUpdates`,
 *   including every socket watching some entirely unrelated collection, on
 *   every single write. It now reads the membership of one room, so the cost
 *   is proportional to this collection's subscribers rather than to the whole
 *   server's subscriptions.
 * - **Delivery** to unfiltered subscribers — the overwhelmingly common case —
 *   is now one `io.to(room).except(...)` broadcast, which Socket.IO
 *   serializes once and writes to each member, instead of a loop of N
 *   individual emits that serialized the same payload N times.
 *
 * Sockets that genuinely need a different payload from everyone else — those
 * whose watches are all filtered, or all of them when the per-document rule
 * re-check is on — are excluded from the broadcast and handled one at a time
 * below, exactly as before.
 */
async function sendUpdateCollectionStreamEvent({ colPath, action, data, project, source = "write" }) {
  if (supersededByChangeStream({ source, project, colPath })) return;

  const docs = Array.isArray(data) ? data : [data];
  if (docs.length === 0) return;

  const io = getIO();
  if (!io) return;

  const event = `update:${colPath}`;
  const room = colRoom(colPath);
  const members = roomMembers(io, room);
  if (members.length === 0) return;

  // Opt-in, default OFF (project.realtimePerDocCheck is undefined on every
  // project that hasn't explicitly turned it on). Off keeps delivery
  // equivalent to the pre-K2 behavior — no per-socket admin lookup or rule
  // evaluation on every push for projects that never asked for this, so the
  // common case doesn't get slower.
  const perDocCheckEnabled = Boolean(project && project.realtimePerDocCheck);

  // Broadcast to everyone entitled to the unmodified batch. With the rule
  // re-check on, nobody is: each socket's batch depends on its own identity.
  if (!perDocCheckEnabled) {
    io.to(room).except(filteredRoom(colPath)).emit(event, { [action]: docs });
  }

  const individual = perDocCheckEnabled
    ? members
    : roomMembers(io, filteredRoom(colPath));
  if (individual.length === 0) return;

  const rulesService = perDocCheckEnabled ? new DbRulesService(project.dbRules) : null;
  // colPath is always `${project.code}/${col}` (see subscribe() and its
  // callers) or `${project.code}/collections` for the schema-listing
  // pseudo-collection — strip the project prefix to recover the rule path
  // segment. watch-collections is admin-only at subscribe time (guarded by
  // socketAdminGuard), so a non-admin ever reaching that colPath here would
  // already be an upstream bug; this path only matters for its documents to
  // fail closed rather than throw if that ever happens.
  const col = perDocCheckEnabled ? colPath.slice(project.code.length + 1) : null;

  for (const socketId of individual) {
    const watches = watchesOn(socketId, colPath);
    // Room membership without a registry entry shouldn't happen — syncWatchRooms
    // derives one from the other — but a socket torn down mid-push would look
    // exactly like this, so skip rather than emit an unfiltered batch.
    if (watches.length === 0) continue;

    // The filter bug this replaced read the whole watch array as a single
    // entry, so `.query` was always undefined and every subscriber received
    // every document regardless of what it asked for.
    //
    // One socket may hold several watches on the same collection under
    // different filters; they share a single event name, so it receives the
    // union of what those filters admit.
    let visible = watches.some((watch) => !watch.query)
      ? docs
      : docs.filter((doc) =>
          watches.some((watch) => matchesQuery(doc, watch.query)),
        );
    if (visible.length === 0) continue;

    if (perDocCheckEnabled) {
      const liveSocket = io.sockets.sockets.get(socketId);
      // Disconnected between subscribe and this push — nothing to send to.
      if (!liveSocket) continue;
      visible = await filterVisibleDocsForSocket({ liveSocket, rulesService, col, docs: visible });
      if (visible.length === 0) continue;
    }

    io.to(socketId).emit(event, { [action]: visible });
  }
}

/**
 * Push for a single document to its `watch-doc` room (the room is named
 * after the raw document id — see the `watch-doc` handler above).
 *
 * Unlike sendUpdateCollectionStreamEvent, this call site has no per-socket
 * watch registry to consult: room membership IS the subscriber list, and
 * Socket.IO gives no built-in way to filter what a room-wide
 * `io.to(room).emit` delivers to individual members. So:
 *
 * - Flag off (default): a single room-wide emit, identical to the code this
 *   replaced — no room-membership enumeration, no extra work.
 * - Flag on: enumerate the room's socket ids ourselves and emit individually,
 *   running the same admin-bypass / per-document rule re-check as the
 *   collection-stream path, so a subscriber who has lost read access to this
 *   exact document since calling watch-doc stops receiving it on the very
 *   next push rather than only on its next resubscribe.
 */
async function sendUpdateDocumentStreamEvent({ project, col, room, action, doc, source = "write" }) {
  // colPath is only used here to spare the `collections` pseudo stream, which
  // has no single-document rooms — any real collection reaches the same
  // verdict, so pass the one this push is for.
  if (supersededByChangeStream({ source, project, colPath: `${project && project.code}/${col}` })) return;

  const io = getIO();

  if (!(project && project.realtimePerDocCheck)) {
    io.to(room).emit(room, { action, doc });
    return;
  }

  const memberIds = io.sockets.adapter.rooms.get(room);
  if (!memberIds || memberIds.size === 0) return;

  const rulesService = new DbRulesService(project.dbRules);
  for (const socketId of memberIds) {
    const liveSocket = io.sockets.sockets.get(socketId);
    if (!liveSocket) continue;
    const visible = await filterVisibleDocsForSocket({
      liveSocket,
      rulesService,
      col,
      docs: [doc],
    });
    if (visible.length === 0) continue;
    io.to(socketId).emit(room, { action, doc: visible[0] });
  }
}

module.exports = {
  dbSockets,
  sendUpdateCollectionStreamEvent,
  sendUpdateDocumentStreamEvent,
  // exported for tests
  __internals: {
    watchingCollectionsUpdates,
    addWatching,
    removeWatching,
    matchesQuery,
    watchKey,
    filterVisibleDocsForSocket,
    colRoom,
    filteredRoom,
    syncWatchRooms,
  },
};
