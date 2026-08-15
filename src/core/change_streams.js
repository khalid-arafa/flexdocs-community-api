/**
 * Change-stream event source for realtime (C6).
 *
 * The default realtime mechanism is emit-after-write: a route handler calls
 * the fan-out itself once its write succeeds. That has two holes it cannot
 * close from inside the request — a write made anywhere other than an HTTP
 * handler (another process, a migration, mongosh) produces no event at all,
 * and a crash between the write committing and the emit running loses the
 * event permanently, because the two are not transactional.
 *
 * Watching MongoDB's oplog closes both. It also costs nothing to the request
 * path, since the emit stops being the handler's job.
 *
 * Two independent gates, and BOTH must be open:
 *
 *   1. Deployment capability. Change streams need a replica set or a sharded
 *      cluster; on standalone mongod the command does not exist. FlexDocs is
 *      self-hosted and plenty of installs run standalone, so this is probed at
 *      startup and simply stays off when unsupported. Nothing requires it.
 *   2. Per-project opt-in, `project.realtimeChangeStreams`, default off. A
 *      project that has not opted in keeps emit-after-write untouched even on
 *      a capable deployment.
 *
 * When both are open for a project, route-originated pushes for that project
 * are suppressed (see sockets/db.sockets.js) so the two sources never both
 * fire for one write. If the stream later dies and cannot be resumed, the
 * driver marks itself not-running and every project falls back to
 * emit-after-write rather than going silent.
 */

const { DatabaseClient } = require("./client");
const { getDocument } = require("./db_service");
const { ProjectDocCache } = require("./project_doc_cache");
const Logger = require("../utils/logger");
const {
  systemDatabaseName,
  systemProjectCode,
  systemProjectCollectionName,
} = require("../constants");
const { setChangeStreamsRunning } = require("./realtime_source");

// Databases that are never a FlexDocs project.
const IGNORED_DATABASES = [systemDatabaseName, "admin", "local", "config"];

// MongoDB change-stream operation type → the action key clients already
// receive from emit-after-write. Anything absent here (drop, rename,
// dropDatabase, shard events, ...) is ignored: the collection-level pseudo
// stream that carries those stays route-driven, see the note in
// sockets/db.sockets.js.
const ACTION_BY_OPERATION = {
  insert: "add",
  update: "update",
  replace: "update",
  delete: "delete",
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PROJECT_CACHE_TTL_MS = 30 * 1000;

let stream = null;
let stopping = false;
let resumeToken = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;

// The driver runs outside the request cycle, so it cannot share projectApiAuth's
// cache INSTANCE — but it wants the same behavior, hence the same
// implementation (core/project_doc_cache.js). The TTL is what makes an admin
// toggling realtimeChangeStreams take effect without a restart; the explicit
// invalidateProject() call from the request-side write sites is what usually
// gets there first.
//
// Misses are cached here (and only here): a change stream sees every database
// on the cluster, including any that is not a FlexDocs project, and without
// that every write to one would re-query the projects collection. The entry
// bound matters for the same reason — the key space is "every database name
// this cluster ever emits an event for", not "every project".
const projectCache = new ProjectDocCache({
  ttlMs: PROJECT_CACHE_TTL_MS,
  cacheMisses: true,
});

/**
 * Does this deployment support change streams?
 *
 * `hello` reports `setName` on a replica-set member and `msg: "isdbgrid"` on a
 * mongos. A standalone mongod reports neither, and is the case this exists to
 * detect — opening a change stream against one throws, and doing that at
 * startup would turn an unsupported-but-perfectly-valid deployment into a
 * crash loop.
 */
async function detectChangeStreamSupport() {
  try {
    const hello = await DatabaseClient.db("admin").command({ hello: 1 });
    return Boolean(hello && (hello.setName || hello.msg === "isdbgrid"));
  } catch (error) {
    Logger.warn("Change-stream capability probe failed; assuming unsupported", {
      error: error.message,
    });
    return false;
  }
}

async function getProject(projectCode) {
  return projectCache.getOrFetch(projectCode, () =>
    getDocument({
      userId: systemDatabaseName,
      projectCode: systemProjectCode,
      collectionName: systemProjectCollectionName,
      query: { code: projectCode },
    }),
  );
}

/** Drops a cached project so the next event re-reads its flags. */
function invalidateProject(projectCode) {
  projectCache.invalidate(projectCode);
}

/**
 * Turns one oplog event into the same push a route handler would have made.
 *
 * Deletes are the one case that cannot always carry a full document: the oplog
 * records only the key unless pre-images are enabled on the collection
 * (`changeStreamPreAndPostImages`, MongoDB 6+). Without them a delete pushes
 * `{ _id }` alone, where emit-after-write pushed the whole document it had
 * just read. Clients remove by id, so this is enough to act on, but a
 * subscriber whose watch carries a FILTER will not match a bare key and so
 * will not be told about the deletion. Enable pre-images on collections where
 * that matters.
 */
async function handleChange(event) {
  const ns = event && event.ns;
  if (!ns || !ns.db || !ns.coll) return;

  const action = ACTION_BY_OPERATION[event.operationType];
  if (!action) return;

  const project = await getProject(ns.db);
  if (!project || !project.realtimeChangeStreams) return;

  let doc;
  if (action === "delete") {
    doc = event.fullDocumentBeforeChange ||
      (event.documentKey ? { _id: event.documentKey._id } : null);
  } else {
    // updateLookup reads the document as it stands now, which is null when it
    // was deleted between the update and the lookup. The delete event that
    // follows carries the truth, so drop this one.
    doc = event.fullDocument || null;
  }
  if (!doc) return;

  // Required lazily: db.sockets.js reads realtime_source.js, which this module
  // writes to, and requiring it at load time would close that loop.
  const {
    sendUpdateCollectionStreamEvent,
    sendUpdateDocumentStreamEvent,
  } = require("../sockets/db.sockets");

  const colPath = `${ns.db}/${ns.coll}`;
  await sendUpdateCollectionStreamEvent({
    colPath,
    action,
    data: [doc],
    project,
    source: "change-stream",
  });

  const documentId = event.documentKey && event.documentKey._id;
  if (documentId != null) {
    await sendUpdateDocumentStreamEvent({
      project,
      col: ns.coll,
      room: String(documentId),
      action,
      doc,
      source: "change-stream",
    });
  }
}

function buildPipeline() {
  return [
    {
      $match: {
        "ns.db": { $nin: IGNORED_DATABASES },
        // Internal collections (_users and friends) are never client-watchable,
        // so events for them would be discarded by the fan-out anyway. Dropping
        // them here keeps account writes off the wire entirely.
        "ns.coll": { $not: { $regex: "^_" } },
        operationType: { $in: Object.keys(ACTION_BY_OPERATION) },
      },
    },
  ];
}

function openStream() {
  const options = { fullDocument: "updateLookup" };
  if (resumeToken) options.startAfter = resumeToken;
  try {
    // Pre-images give deletes their full document. "whenAvailable" degrades to
    // no pre-image per collection rather than erroring, but the OPTION itself
    // is unknown before MongoDB 6 — hence the retry below.
    return DatabaseClient.watch(buildPipeline(), {
      ...options,
      fullDocumentBeforeChange: "whenAvailable",
    });
  } catch {
    return DatabaseClient.watch(buildPipeline(), options);
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  Logger.warn(`Change stream: retrying in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    run();
  }, delay);
  // Never hold the process open just to retry a stream.
  if (reconnectTimer.unref) reconnectTimer.unref();
}

async function run() {
  if (stopping) return;
  try {
    stream = openStream();
    setChangeStreamsRunning(true);
    Logger.info("Change stream: watching for realtime events");

    for await (const event of stream) {
      // Recorded before handling, so a handler that throws still lets the
      // retry resume past the event rather than replaying it forever.
      resumeToken = event._id || resumeToken;
      reconnectDelay = RECONNECT_BASE_MS;
      try {
        await handleChange(event);
      } catch (error) {
        Logger.error("Change stream: handler failed", {
          error: error.message,
          stack: error.stack,
        });
      }
    }
    // Iteration ended without an error — the stream was closed under us.
    if (!stopping) {
      setChangeStreamsRunning(false);
      scheduleReconnect();
    }
  } catch (error) {
    // Every project falls back to emit-after-write for as long as this is
    // false, so a broken stream degrades to today's behavior instead of
    // silence.
    setChangeStreamsRunning(false);
    if (stopping) return;
    Logger.error("Change stream: failed", { error: error.message, stack: error.stack });
    // A resume token the server no longer has in its oplog can never succeed;
    // drop it and rejoin at the present, accepting the gap.
    if (error.code === 286 /* ChangeStreamHistoryLost */) {
      Logger.warn("Change stream: resume history lost, restarting from now");
      resumeToken = null;
    }
    scheduleReconnect();
  }
}

/**
 * Probes the deployment and starts watching if it can.
 *
 * Never throws and never blocks startup on the stream itself: returns false
 * and leaves emit-after-write in charge if anything is wrong.
 */
async function startChangeStreams() {
  if (stream) return true;
  stopping = false;

  const supported = await detectChangeStreamSupport();
  if (!supported) {
    Logger.info(
      "Change streams unavailable (standalone MongoDB); realtime stays on emit-after-write",
    );
    setChangeStreamsRunning(false);
    return false;
  }

  // Not awaited: run() only returns when the stream ends.
  run();
  return true;
}

async function stopChangeStreams() {
  stopping = true;
  setChangeStreamsRunning(false);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const open = stream;
  stream = null;
  if (open) {
    try {
      await open.close();
    } catch (error) {
      Logger.warn("Change stream: close failed", { error: error.message });
    }
  }
}

module.exports = {
  startChangeStreams,
  stopChangeStreams,
  detectChangeStreamSupport,
  invalidateProject,
  // exported for tests
  __internals: { handleChange, buildPipeline, getProject, projectCache, ACTION_BY_OPERATION },
};
