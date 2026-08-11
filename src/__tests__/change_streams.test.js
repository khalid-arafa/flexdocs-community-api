/**
 * C6 — change-stream event source.
 *
 * Two gates guard this feature and the tests are organised around them,
 * because getting either wrong is what would break a live deployment:
 *
 *   capability — standalone MongoDB has no change streams. The driver must
 *                detect that and stay off rather than crash-looping at
 *                startup, since FlexDocs is self-hosted and standalone is a
 *                perfectly valid way to run it.
 *   opt-in     — project.realtimeChangeStreams, default off. A project that
 *                has not asked for this keeps emit-after-write exactly as it
 *                was, even on a capable deployment.
 *
 * And one invariant spanning both: a single write must produce exactly one
 * push. Never two (both sources firing), never zero (route suppressed for a
 * stream that isn't running).
 */

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service", () => ({ getDocument: jest.fn() }));

const mockCommand = jest.fn();
jest.mock("../core/client", () => ({
  DatabaseClient: {
    db: () => ({ command: mockCommand }),
    watch: jest.fn(),
  },
}));

const mockSendCollection = jest.fn();
const mockSendDocument = jest.fn();
jest.mock("../sockets/db.sockets", () => ({
  sendUpdateCollectionStreamEvent: mockSendCollection,
  sendUpdateDocumentStreamEvent: mockSendDocument,
}));

const { getDocument } = require("../core/db_service");
const {
  detectChangeStreamSupport,
  startChangeStreams,
  invalidateProject,
  __internals,
} = require("../core/change_streams");
const {
  setChangeStreamsRunning,
  changeStreamsActiveFor,
  areChangeStreamsRunning,
} = require("../core/realtime_source");

const { handleChange, buildPipeline, projectCache } = __internals;

function project(overrides = {}) {
  return { code: "proj1", name: "P", dbRules: {}, ...overrides };
}

function changeEvent(overrides = {}) {
  return {
    _id: { _data: "token1" },
    operationType: "insert",
    ns: { db: "proj1", coll: "posts" },
    documentKey: { _id: "doc1" },
    fullDocument: { _id: "doc1", title: "hello" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  projectCache.clear();
  setChangeStreamsRunning(false);
});

// ─── Gate 1: deployment capability ────────────────────────────────────────
describe("detectChangeStreamSupport", () => {
  it("detects a replica set by its setName", async () => {
    mockCommand.mockResolvedValue({ setName: "rs0", ok: 1 });
    expect(await detectChangeStreamSupport()).toBe(true);
  });

  it("detects a sharded cluster by the mongos marker", async () => {
    mockCommand.mockResolvedValue({ msg: "isdbgrid", ok: 1 });
    expect(await detectChangeStreamSupport()).toBe(true);
  });

  it("reports standalone MongoDB as unsupported", async () => {
    mockCommand.mockResolvedValue({ ok: 1 });
    expect(await detectChangeStreamSupport()).toBe(false);
  });

  it("treats a failed probe as unsupported instead of throwing", async () => {
    mockCommand.mockRejectedValue(new Error("connection refused"));
    await expect(detectChangeStreamSupport()).resolves.toBe(false);
  });
});

describe("startChangeStreams on an incapable deployment", () => {
  it("returns false, never opens a stream, and leaves the flag off", async () => {
    mockCommand.mockResolvedValue({ ok: 1 });
    const { DatabaseClient } = require("../core/client");

    await expect(startChangeStreams()).resolves.toBe(false);

    expect(DatabaseClient.watch).not.toHaveBeenCalled();
    expect(areChangeStreamsRunning()).toBe(false);
    // Which is what keeps every project on emit-after-write.
    expect(changeStreamsActiveFor(project({ realtimeChangeStreams: true }))).toBe(false);
  });
});

// ─── Gate 2: per-project opt-in ───────────────────────────────────────────
describe("changeStreamsActiveFor", () => {
  it("is false while the driver is not running, even for an opted-in project", () => {
    setChangeStreamsRunning(false);
    expect(changeStreamsActiveFor(project({ realtimeChangeStreams: true }))).toBe(false);
  });

  it("is false for a project that has not opted in, even while running", () => {
    setChangeStreamsRunning(true);
    expect(changeStreamsActiveFor(project())).toBe(false);
  });

  it("is true only when both gates are open", () => {
    setChangeStreamsRunning(true);
    expect(changeStreamsActiveFor(project({ realtimeChangeStreams: true }))).toBe(true);
  });

  it("tolerates a missing project", () => {
    setChangeStreamsRunning(true);
    expect(changeStreamsActiveFor(null)).toBe(false);
    expect(changeStreamsActiveFor(undefined)).toBe(false);
  });
});

// ─── Event translation ────────────────────────────────────────────────────
describe("handleChange", () => {
  function optedIn() {
    getDocument.mockResolvedValue(project({ realtimeChangeStreams: true }));
  }

  it("pushes an insert as an add, tagged as change-stream sourced", async () => {
    optedIn();
    await handleChange(changeEvent());

    expect(mockSendCollection).toHaveBeenCalledWith({
      colPath: "proj1/posts",
      action: "add",
      data: [{ _id: "doc1", title: "hello" }],
      project: expect.objectContaining({ code: "proj1" }),
      source: "change-stream",
    });
  });

  it.each([
    ["insert", "add"],
    ["update", "update"],
    ["replace", "update"],
  ])("maps %s to %s", async (operationType, action) => {
    optedIn();
    await handleChange(changeEvent({ operationType }));
    expect(mockSendCollection).toHaveBeenCalledWith(
      expect.objectContaining({ action }),
    );
  });

  it("also pushes to the single-document room", async () => {
    optedIn();
    await handleChange(changeEvent());
    expect(mockSendDocument).toHaveBeenCalledWith({
      project: expect.objectContaining({ code: "proj1" }),
      col: "posts",
      room: "doc1",
      action: "add",
      doc: { _id: "doc1", title: "hello" },
      source: "change-stream",
    });
  });

  it("stringifies an ObjectId document key for the room name", async () => {
    optedIn();
    const oid = { toString: () => "64b7f9c2e1a2b3c4d5e6f7a8" };
    await handleChange(changeEvent({ documentKey: { _id: oid } }));
    expect(mockSendDocument).toHaveBeenCalledWith(
      expect.objectContaining({ room: "64b7f9c2e1a2b3c4d5e6f7a8" }),
    );
  });

  it("emits nothing for a project that has not opted in", async () => {
    getDocument.mockResolvedValue(project());
    await handleChange(changeEvent());
    expect(mockSendCollection).not.toHaveBeenCalled();
    expect(mockSendDocument).not.toHaveBeenCalled();
  });

  it("emits nothing for a database that is not a FlexDocs project", async () => {
    getDocument.mockResolvedValue(null);
    await handleChange(changeEvent({ ns: { db: "someone-elses-db", coll: "posts" } }));
    expect(mockSendCollection).not.toHaveBeenCalled();
  });

  it("ignores operation types it has no action for", async () => {
    optedIn();
    for (const operationType of ["drop", "rename", "dropDatabase", "invalidate"]) {
      await handleChange(changeEvent({ operationType }));
    }
    expect(mockSendCollection).not.toHaveBeenCalled();
  });

  it("ignores an event with no namespace", async () => {
    optedIn();
    await handleChange({ operationType: "insert" });
    await handleChange({ operationType: "insert", ns: { db: "proj1" } });
    expect(mockSendCollection).not.toHaveBeenCalled();
  });

  it("drops an update whose lookup found the document already deleted", async () => {
    optedIn();
    // updateLookup returns null when the document went away between the write
    // and the lookup; the delete event that follows carries the truth.
    await handleChange(changeEvent({ operationType: "update", fullDocument: null }));
    expect(mockSendCollection).not.toHaveBeenCalled();
  });

  describe("deletes", () => {
    it("uses the pre-image when the collection has them enabled", async () => {
      optedIn();
      await handleChange(
        changeEvent({
          operationType: "delete",
          fullDocument: undefined,
          fullDocumentBeforeChange: { _id: "doc1", title: "gone", ownerId: "u1" },
        }),
      );
      expect(mockSendCollection).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "delete",
          data: [{ _id: "doc1", title: "gone", ownerId: "u1" }],
        }),
      );
    });

    it("falls back to the bare key when no pre-image is available", async () => {
      optedIn();
      await handleChange(
        changeEvent({ operationType: "delete", fullDocument: undefined }),
      );
      expect(mockSendCollection).toHaveBeenCalledWith(
        expect.objectContaining({ action: "delete", data: [{ _id: "doc1" }] }),
      );
    });
  });
});

describe("project lookup cache", () => {
  it("reads the project once across repeated events", async () => {
    getDocument.mockResolvedValue(project({ realtimeChangeStreams: true }));
    await handleChange(changeEvent());
    await handleChange(changeEvent());
    await handleChange(changeEvent());
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("caches a miss so foreign databases do not re-query on every write", async () => {
    getDocument.mockResolvedValue(null);
    await handleChange(changeEvent({ ns: { db: "not-a-project", coll: "x" } }));
    await handleChange(changeEvent({ ns: { db: "not-a-project", coll: "x" } }));
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("re-reads after invalidateProject, so toggling the flag takes effect", async () => {
    getDocument.mockResolvedValue(project());
    await handleChange(changeEvent());
    expect(mockSendCollection).not.toHaveBeenCalled();

    getDocument.mockResolvedValue(project({ realtimeChangeStreams: true }));
    invalidateProject("proj1");
    await handleChange(changeEvent());

    expect(mockSendCollection).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledTimes(2);
  });
});

describe("server-side pipeline filter", () => {
  const [{ $match }] = buildPipeline();

  it("excludes the system and MongoDB-internal databases", () => {
    expect($match["ns.db"].$nin).toEqual(
      expect.arrayContaining(["_system", "admin", "local", "config"]),
    );
  });

  it("excludes underscore-prefixed collections, so account writes never leave the server", () => {
    const pattern = new RegExp($match["ns.coll"].$not.$regex);
    expect(pattern.test("_users")).toBe(true);
    expect(pattern.test("posts")).toBe(false);
  });

  it("requests only the operation types that map to a client action", () => {
    expect($match.operationType.$in.sort()).toEqual(
      ["delete", "insert", "replace", "update"],
    );
  });
});
