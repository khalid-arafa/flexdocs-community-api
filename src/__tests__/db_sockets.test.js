/**
 * Regression tests for the collection-watch registry and realtime fan-out.
 *
 * This module previously had no coverage, which is how the filter bug below
 * survived: `sendUpdateCollectionStreamEvent` read the per-socket watch *array*
 * as if it were a single watch entry, so `.query` was always undefined and the
 * filter branch never ran.
 *
 * Since K3 the fan-out finds its subscribers through real Socket.IO rooms
 * rather than by scanning the registry, so these tests drive a miniature
 * adapter (rooms as `room → Set<socketId>`, plus the chainable
 * `to().except().emit()` surface) and assert on **what each socket actually
 * received**. That is deliberately stricter than the old assertions on which
 * internal emit path ran: it holds the wire format fixed while the delivery
 * strategy underneath it changes.
 */

// ─── Socket.IO test double ────────────────────────────────────────────────
const rooms = new Map(); // room → Set<socketId>
const liveSockets = new Map(); // socketId → fake socket
const delivered = []; // { socketId, event, payload }, in emit order
// One entry per emit() call, regardless of how many sockets it reached. This
// is what distinguishes a room broadcast (Socket.IO serializes the payload
// once) from the loop of per-recipient emits K3 replaced, so it is the only
// way to assert the actual point of that change.
const emitCalls = [];

function membersOf(room) {
  return rooms.get(room) || new Set();
}

function makeEmitter(include, exclude) {
  return {
    except: (room) => makeEmitter(include, [...exclude, room]),
    emit: (event, payload) => {
      const targets = new Set();
      for (const room of include) for (const id of membersOf(room)) targets.add(id);
      for (const room of exclude) for (const id of membersOf(room)) targets.delete(id);
      emitCalls.push({ include: [...include], exclude: [...exclude], event, reached: targets.size });
      for (const socketId of targets) delivered.push({ socketId, event, payload });
    },
  };
}

const mockIO = {
  to: (room) => makeEmitter([room], []),
  sockets: { sockets: liveSockets, adapter: { rooms } },
};

jest.mock("../sockets/io_connect", () => ({ getIO: () => mockIO }));
jest.mock("../core/db_service", () => ({ getDocument: jest.fn() }));
jest.mock("../middleware/db_rules.middleware", () => ({
  socketDocGuard: jest.fn(),
  socketColGuard: jest.fn(),
  socketAdminGuard: jest.fn(),
  isAdminSocket: jest.fn(),
}));

const {
  sendUpdateCollectionStreamEvent,
  sendUpdateDocumentStreamEvent,
  __internals,
} = require("../sockets/db.sockets");
const { socketLimits } = require("../constants");
const { isAdminSocket } = require("../middleware/db_rules.middleware");

const {
  watchingCollectionsUpdates: registry,
  addWatching,
  removeWatching,
  matchesQuery,
  watchKey,
  colRoom,
  filteredRoom,
  syncWatchRooms,
} = __internals;

const COL = "proj1/posts";

/**
 * A socket that joins and leaves rooms the way Socket.IO's does, including the
 * implicit room named after its own id — that is what makes `io.to(socketId)`
 * work, and the per-socket branch of the fan-out relies on it.
 */
function connect(socketId, sender) {
  const socket = {
    id: socketId,
    sender,
    join(room) {
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(socketId);
    },
    leave(room) {
      const members = rooms.get(room);
      if (!members) return;
      members.delete(socketId);
      if (members.size === 0) rooms.delete(room);
    },
  };
  liveSockets.set(socketId, socket);
  socket.join(socketId);
  return socket;
}

/** Registers a watch exactly as the `watch-col-updates` handler does. */
function subscribe(socket, colPath, data) {
  const accepted = addWatching(registry, socket.id, colPath, data);
  if (accepted) syncWatchRooms(socket, colPath);
  return accepted;
}

/** Drops a watch exactly as the `unwatch-col-updates` handler does. */
function unsubscribe(socket, colPath) {
  removeWatching(registry, socket.id, colPath);
  syncWatchRooms(socket, colPath);
}

/** Payloads this socket received, oldest first. */
function payloadsFor(socketId, event = `update:${COL}`) {
  return delivered
    .filter((d) => d.socketId === socketId && d.event === event)
    .map((d) => d.payload);
}

function reset() {
  for (const key of Object.keys(registry)) delete registry[key];
  rooms.clear();
  liveSockets.clear();
  delivered.length = 0;
  emitCalls.length = 0;
  // Default to "not admin" so tests that exercise the per-doc-rule path don't
  // silently bypass it by inheriting a truthy value left over from another
  // test (clearMocks resets call history, not mockResolvedValue).
  isAdminSocket.mockResolvedValue(null);
}

beforeEach(reset);

describe("addWatching / removeWatching", () => {
  it("registers a watch and dedups an identical one", () => {
    expect(addWatching(registry, "s1", COL, {})).toBe(true);
    expect(addWatching(registry, "s1", COL, {})).toBe(true);
    expect(registry.s1.size).toBe(1);
  });

  it("dedups filters written in a different key order", () => {
    addWatching(registry, "s1", COL, { query: { a: 1, b: 2 } });
    addWatching(registry, "s1", COL, { query: { b: 2, a: 1 } });
    expect(registry.s1.size).toBe(1);
  });

  it("keeps distinct filters on the same collection apart", () => {
    addWatching(registry, "s1", COL, { query: { ownerId: "u1" } });
    addWatching(registry, "s1", COL, { query: { ownerId: "u2" } });
    expect(registry.s1.size).toBe(2);
  });

  it("treats an empty query object as unfiltered", () => {
    expect(watchKey(COL, undefined)).toBe(COL);
    addWatching(registry, "s1", COL, { query: {} });
    expect([...registry.s1.values()][0].query).toBeUndefined();
  });

  it("caps the registry so a long-lived socket cannot grow without bound", () => {
    for (let i = 0; i < socketLimits.maxWatchesPerSocket; i++) {
      expect(addWatching(registry, "s1", `proj1/c${i}`, {})).toBe(true);
    }
    expect(addWatching(registry, "s1", "proj1/overflow", {})).toBe(false);
    expect(registry.s1.size).toBe(socketLimits.maxWatchesPerSocket);
  });

  it("removes every filter held on a collection and drops the empty socket", () => {
    addWatching(registry, "s1", COL, { query: { ownerId: "u1" } });
    addWatching(registry, "s1", COL, { query: { ownerId: "u2" } });
    removeWatching(registry, "s1", COL);
    expect(registry.s1).toBeUndefined();
  });

  it("leaves other collections intact when unwatching one", () => {
    addWatching(registry, "s1", COL, {});
    addWatching(registry, "s1", "proj1/comments", {});
    removeWatching(registry, "s1", COL);
    expect(registry.s1.size).toBe(1);
    expect([...registry.s1.values()][0].colPath).toBe("proj1/comments");
  });

  it("is a no-op for an unknown socket", () => {
    expect(() => removeWatching(registry, "nope", COL)).not.toThrow();
  });
});

describe("matchesQuery", () => {
  it("matches on equality across every key", () => {
    expect(matchesQuery({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(matchesQuery({ a: 1, b: "x" }, { a: 1, b: "y" })).toBe(false);
  });

  it("compares ObjectId-like fields against client strings", () => {
    const oid = { toString: () => "64b7f9c2e1a2b3c4d5e6f7a8" };
    expect(matchesQuery({ _id: oid }, { _id: "64b7f9c2e1a2b3c4d5e6f7a8" })).toBe(true);
    expect(matchesQuery({ _id: oid }, { _id: "different" })).toBe(false);
  });

  it("does not match a missing field against a value", () => {
    expect(matchesQuery({ a: 1 }, { missing: "x" })).toBe(false);
  });

  it("rejects non-object documents rather than throwing", () => {
    expect(matchesQuery(null, { a: 1 })).toBe(false);
    expect(matchesQuery("str", { a: 1 })).toBe(false);
  });
});

// ─── K3: room membership is derived from the registry, never set by hand ───
describe("syncWatchRooms", () => {
  it("puts an unfiltered subscriber in the collection room only", () => {
    const s1 = connect("s1");
    subscribe(s1, COL, {});
    expect(membersOf(colRoom(COL)).has("s1")).toBe(true);
    expect(membersOf(filteredRoom(COL)).has("s1")).toBe(false);
  });

  it("puts a filtered subscriber in both rooms", () => {
    const s1 = connect("s1");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    expect(membersOf(colRoom(COL)).has("s1")).toBe(true);
    expect(membersOf(filteredRoom(COL)).has("s1")).toBe(true);
  });

  it("drops out of the filtered room as soon as an unfiltered watch is added", () => {
    const s1 = connect("s1");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    subscribe(s1, COL, {});
    // An unfiltered watch already entitles it to the whole batch, so it takes
    // the broadcast with everyone else rather than a hand-built payload.
    expect(membersOf(filteredRoom(COL)).has("s1")).toBe(false);
    expect(membersOf(colRoom(COL)).has("s1")).toBe(true);
  });

  it("leaves both rooms when the last watch on the collection goes", () => {
    const s1 = connect("s1");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    unsubscribe(s1, COL);
    expect(membersOf(colRoom(COL)).size).toBe(0);
    expect(membersOf(filteredRoom(COL)).size).toBe(0);
  });

  it("does not join any room when the subscription cap rejects the watch", () => {
    const s1 = connect("s1");
    for (let i = 0; i < socketLimits.maxWatchesPerSocket; i++) {
      subscribe(s1, `proj1/c${i}`, {});
    }
    expect(subscribe(s1, COL, {})).toBe(false);
    expect(membersOf(colRoom(COL)).size).toBe(0);
  });

  it("keeps membership on other collections when one is unwatched", () => {
    const s1 = connect("s1");
    subscribe(s1, COL, {});
    subscribe(s1, "proj1/comments", {});
    unsubscribe(s1, COL);
    expect(membersOf(colRoom(COL)).size).toBe(0);
    expect(membersOf(colRoom("proj1/comments")).has("s1")).toBe(true);
  });
});

describe("sendUpdateCollectionStreamEvent", () => {
  it("delivers to an unfiltered subscriber", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "1", ownerId: "u1" }],
    });
    expect(payloadsFor("s1")).toEqual([{ update: [{ _id: "1", ownerId: "u1" }] }]);
  });

  // The bug this module existed to hide: a filtered subscriber used to receive
  // every document in the collection, because the filter branch never ran.
  it("delivers only documents matching the subscriber's filter", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
    });
    expect(payloadsFor("s1")).toEqual([{ update: [{ _id: "1", ownerId: "u1" }] }]);
  });

  it("stays silent when nothing matches the filter", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "2", ownerId: "u2" }],
    });
    expect(delivered).toHaveLength(0);
  });

  it("sends the union when one socket holds several filters", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    subscribe(s1, COL, { query: { ownerId: "u2" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
        { _id: "3", ownerId: "u3" },
      ],
    });
    const received = payloadsFor("s1");
    expect(received).toHaveLength(1);
    expect(received[0].update).toHaveLength(2);
  });

  it("gives an unfiltered watch everything even alongside a filtered one", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    subscribe(s1, COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
    });
    const received = payloadsFor("s1");
    // Exactly one payload — it must not also pick up a per-socket emit and
    // receive the batch twice.
    expect(received).toHaveLength(1);
    expect(received[0].update).toHaveLength(2);
  });

  it("filters per socket rather than globally", async () => {
    const s1 = connect("s1");
    const s2 = connect("s2");
    subscribe(s1, COL, { query: { ownerId: "u1" } });
    subscribe(s2, COL, { query: { ownerId: "u2" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
    });
    expect(payloadsFor("s1")).toEqual([{ update: [{ _id: "1", ownerId: "u1" }] }]);
    expect(payloadsFor("s2")).toEqual([{ update: [{ _id: "2", ownerId: "u2" }] }]);
  });

  it("serves a broadcast subscriber and a filtered one from the same push", async () => {
    const s1 = connect("s1");
    const s2 = connect("s2");
    subscribe(s1, COL, {});
    subscribe(s2, COL, { query: { ownerId: "u1" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
    });
    expect(payloadsFor("s1")[0].update).toHaveLength(2);
    expect(payloadsFor("s2")[0].update).toHaveLength(1);
  });

  // The point of K3. Before it, this push cost three emits — the same payload
  // serialized once per subscriber — and a scan of every watching socket on
  // the server. Asserting the emit *count* rather than just the deliveries is
  // what stops a future refactor from quietly regressing to the loop.
  it("reaches every unfiltered subscriber with a single broadcast emit", async () => {
    const ids = ["s1", "s2", "s3"];
    for (const id of ids) subscribe(connect(id), COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "add",
      data: [{ _id: "1" }],
    });
    for (const id of ids) {
      expect(payloadsFor(id)).toEqual([{ add: [{ _id: "1" }] }]);
    }
    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]).toMatchObject({
      include: [colRoom(COL)],
      exclude: [filteredRoom(COL)],
      reached: 3,
    });
  });

  it("costs one broadcast plus one emit per filtered subscriber, not one per socket", async () => {
    for (const id of ["s1", "s2", "s3"]) subscribe(connect(id), COL, {});
    subscribe(connect("s4"), COL, { query: { ownerId: "u1" } });

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "add",
      data: [{ _id: "1", ownerId: "u1" }],
    });

    // 1 broadcast covering s1–s3, plus 1 targeted emit for s4.
    expect(emitCalls).toHaveLength(2);
    expect(emitCalls[0].reached).toBe(3);
    expect(emitCalls[1]).toMatchObject({ include: ["s4"], reached: 1 });
  });

  it("does not scan or emit for sockets subscribed to other collections", async () => {
    subscribe(connect("s1"), COL, {});
    for (const id of ["s2", "s3"]) subscribe(connect(id), "proj1/unrelated", {});

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "add",
      data: [{ _id: "1" }],
    });

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].reached).toBe(1);
    expect(payloadsFor("s2")).toEqual([]);
    expect(payloadsFor("s3")).toEqual([]);
  });

  it("ignores sockets watching a different collection", async () => {
    const s1 = connect("s1");
    subscribe(s1, "proj1/other", {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "add",
      data: [{ _id: "1" }],
    });
    expect(delivered).toHaveLength(0);
  });

  it("stops delivering after the subscriber unwatches", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, {});
    unsubscribe(s1, COL);
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "1" }],
    });
    expect(delivered).toHaveLength(0);
  });

  it("preserves the action key in the payload", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "delete",
      data: [{ _id: "1" }],
    });
    expect(payloadsFor("s1")[0]).toHaveProperty("delete");
  });

  it("does not emit for an empty document list", async () => {
    const s1 = connect("s1");
    subscribe(s1, COL, {});
    await sendUpdateCollectionStreamEvent({ colPath: COL, action: "update", data: [] });
    expect(delivered).toHaveLength(0);
  });

  it("does nothing when the collection has no subscribers at all", async () => {
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "1" }],
    });
    expect(delivered).toHaveLength(0);
  });
});

// ─── K2: per-project, per-document realtime dbRules re-check on push ───────
//
// project.realtimePerDocCheck (default undefined/false — see
// system/projects.routes.js PROJECT_UPDATABLE_FIELDS). Off must reproduce the
// exact pre-K2 deliveries above; on, a non-admin subscriber's batch narrows
// to whatever it can currently read, while an admin socket is unaffected.
describe("sendUpdateCollectionStreamEvent — realtime per-document rule re-check (K2)", () => {
  it("flag off is unchanged even when dbRules would deny everything", async () => {
    const s1 = connect("s1", { uid: "u1" });
    subscribe(s1, COL, {});
    const project = { code: "proj1", dbRules: { "/posts": false }, realtimePerDocCheck: false };

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "1", ownerId: "u1" }],
      project,
    });

    expect(payloadsFor("s1")).toEqual([{ update: [{ _id: "1", ownerId: "u1" }] }]);
    expect(isAdminSocket).not.toHaveBeenCalled();
  });

  it("omitting `project` altogether behaves identically to flag off", async () => {
    const s1 = connect("s1", { uid: "u1" });
    subscribe(s1, COL, {});

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "1", ownerId: "u1" }],
    });

    expect(payloadsFor("s1")).toEqual([{ update: [{ _id: "1", ownerId: "u1" }] }]);
  });

  it("an admin socket still receives everything with the flag on, even under a deny-all rule", async () => {
    isAdminSocket.mockResolvedValue({ _id: "admin1" });
    const s1 = connect("s1", undefined);
    subscribe(s1, COL, {});
    const project = { code: "proj1", dbRules: { "/posts": false }, realtimePerDocCheck: true };

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
      project,
    });

    expect(payloadsFor("s1")).toEqual([
      {
        update: [
          { _id: "1", ownerId: "u1" },
          { _id: "2", ownerId: "u2" },
        ],
      },
    ]);
  });

  it("a non-admin socket with a restrictive per-doc rule stops receiving documents it can no longer read", async () => {
    const s1 = connect("s1", { uid: "u1" });
    subscribe(s1, COL, {});
    const project = {
      code: "proj1",
      dbRules: { "/posts": { read: "doc.ownerId == user.uid" } },
      realtimePerDocCheck: true,
    };

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
      project,
    });

    expect(payloadsFor("s1")).toEqual([{ update: [{ _id: "1", ownerId: "u1" }] }]);
  });

  it("an unfiltered subscriber is excluded from the broadcast when the flag is on", async () => {
    // The broadcast can't apply per-identity rules, so with the flag on every
    // socket — filtered or not — must go through the per-socket path. If the
    // broadcast still fired, this socket would receive the denied document.
    const s1 = connect("s1", { uid: "u1" });
    subscribe(s1, COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "2", ownerId: "u2" }],
      project: {
        code: "proj1",
        dbRules: { "/posts": { read: "doc.ownerId == user.uid" } },
        realtimePerDocCheck: true,
      },
    });
    expect(delivered).toHaveLength(0);
  });

  it("a non-admin socket with a permissive rule is unaffected", async () => {
    const s1 = connect("s1", { uid: "u1" });
    subscribe(s1, COL, {});
    const project = {
      code: "proj1",
      dbRules: { "/posts": { read: true } },
      realtimePerDocCheck: true,
    };

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
      project,
    });

    expect(payloadsFor("s1")).toEqual([
      {
        update: [
          { _id: "1", ownerId: "u1" },
          { _id: "2", ownerId: "u2" },
        ],
      },
    ]);
  });

  it("stays silent for a socket that disconnected between subscribe and this push", async () => {
    const s1 = connect("s1", { uid: "u1" });
    subscribe(s1, COL, {});
    // Room membership survives; the live socket is gone.
    liveSockets.delete("s1");
    const project = { code: "proj1", dbRules: { "/posts": { read: true } }, realtimePerDocCheck: true };

    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "1", ownerId: "u1" }],
      project,
    });

    expect(delivered).toHaveLength(0);
  });
});

describe("sendUpdateDocumentStreamEvent (watch-doc room push, K2)", () => {
  const ROOM = "doc1";

  it("flag off emits room-wide exactly like the plain io.to(room).emit(room, ...) it replaced", async () => {
    const s1 = connect("s1");
    s1.join(ROOM);
    const doc = { _id: ROOM, ownerId: "u1" };
    await sendUpdateDocumentStreamEvent({
      project: { code: "proj1", dbRules: {}, realtimePerDocCheck: false },
      col: "posts",
      room: ROOM,
      action: "update",
      doc,
    });
    expect(payloadsFor("s1", ROOM)).toEqual([{ action: "update", doc }]);
    expect(isAdminSocket).not.toHaveBeenCalled();
  });

  it("omitting `project` also takes the flag-off path", async () => {
    const s1 = connect("s1");
    s1.join(ROOM);
    const doc = { _id: ROOM };
    await sendUpdateDocumentStreamEvent({ room: ROOM, action: "delete", doc });
    expect(payloadsFor("s1", ROOM)).toEqual([{ action: "delete", doc }]);
  });

  it("flag on: an admin room member still receives the document under a deny-all rule", async () => {
    isAdminSocket.mockResolvedValue({ _id: "admin1" });
    const s1 = connect("s1", undefined);
    s1.join(ROOM);
    const doc = { _id: ROOM, ownerId: "u2" };

    await sendUpdateDocumentStreamEvent({
      project: { code: "proj1", dbRules: { "/posts": false }, realtimePerDocCheck: true },
      col: "posts",
      room: ROOM,
      action: "update",
      doc,
    });

    expect(payloadsFor("s1", ROOM)).toEqual([{ action: "update", doc }]);
  });

  it("flag on: a non-admin member who can no longer read the doc gets nothing", async () => {
    const s1 = connect("s1", { uid: "u1" });
    s1.join(ROOM);

    await sendUpdateDocumentStreamEvent({
      project: {
        code: "proj1",
        dbRules: { "/posts": { read: "doc.ownerId == user.uid" } },
        realtimePerDocCheck: true,
      },
      col: "posts",
      room: ROOM,
      action: "update",
      doc: { _id: ROOM, ownerId: "u2" },
    });

    expect(delivered).toHaveLength(0);
  });

  it("flag on: a non-admin member with a permissive rule still receives the document", async () => {
    const s1 = connect("s1", { uid: "u1" });
    s1.join(ROOM);
    const doc = { _id: ROOM, ownerId: "u1" };

    await sendUpdateDocumentStreamEvent({
      project: { code: "proj1", dbRules: { "/posts": { read: true } }, realtimePerDocCheck: true },
      col: "posts",
      room: ROOM,
      action: "update",
      doc,
    });

    expect(payloadsFor("s1", ROOM)).toEqual([{ action: "update", doc }]);
  });

  it("flag on: filters per room member — one still sees the doc, the other doesn't", async () => {
    const s1 = connect("s1", { uid: "u1" });
    const s2 = connect("s2", { uid: "u2" });
    s1.join(ROOM);
    s2.join(ROOM);
    const doc = { _id: ROOM, ownerId: "u1" };

    await sendUpdateDocumentStreamEvent({
      project: {
        code: "proj1",
        dbRules: { "/posts": { read: "doc.ownerId == user.uid" } },
        realtimePerDocCheck: true,
      },
      col: "posts",
      room: ROOM,
      action: "update",
      doc,
    });

    expect(payloadsFor("s1", ROOM)).toEqual([{ action: "update", doc }]);
    expect(payloadsFor("s2", ROOM)).toEqual([]);
  });

  it("flag on: does nothing when the room has no members", async () => {
    await sendUpdateDocumentStreamEvent({
      project: { code: "proj1", dbRules: {}, realtimePerDocCheck: true },
      col: "posts",
      room: "empty-room",
      action: "update",
      doc: { _id: "empty-room" },
    });
    expect(delivered).toHaveLength(0);
  });
});
