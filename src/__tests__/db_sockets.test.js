/**
 * Regression tests for the collection-watch registry and realtime fan-out.
 *
 * This module previously had no coverage, which is how the filter bug below
 * survived: `sendUpdateCollectionStreamEvent` read the per-socket watch *array*
 * as if it were a single watch entry, so `.query` was always undefined and the
 * filter branch never ran.
 */

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));

jest.mock("../sockets/io_connect", () => ({
  getIO: () => ({ to: mockTo }),
}));
jest.mock("../core/db_service", () => ({ getDocument: jest.fn() }));
jest.mock("../middleware/db_rules.middleware", () => ({
  socketDocGuard: jest.fn(),
  socketColGuard: jest.fn(),
  socketAdminGuard: jest.fn(),
}));

const {
  sendUpdateCollectionStreamEvent,
  __internals,
} = require("../sockets/db.sockets");
const { socketLimits } = require("../constants");

const {
  watchingCollectionsUpdates: registry,
  addWatching,
  removeWatching,
  matchesQuery,
  watchKey,
} = __internals;

const COL = "proj1/posts";

function reset() {
  for (const key of Object.keys(registry)) delete registry[key];
  mockEmit.mockClear();
  mockTo.mockClear();
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

describe("sendUpdateCollectionStreamEvent", () => {
  it("delivers to an unfiltered subscriber", async () => {
    addWatching(registry, "s1", COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "1", ownerId: "u1" }],
    });
    expect(mockTo).toHaveBeenCalledWith("s1");
    expect(mockEmit).toHaveBeenCalledWith(`update:${COL}`, {
      update: [{ _id: "1", ownerId: "u1" }],
    });
  });

  // The bug this module existed to hide: a filtered subscriber used to receive
  // every document in the collection, because the filter branch never ran.
  it("delivers only documents matching the subscriber's filter", async () => {
    addWatching(registry, "s1", COL, { query: { ownerId: "u1" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
    });
    expect(mockEmit).toHaveBeenCalledWith(`update:${COL}`, {
      update: [{ _id: "1", ownerId: "u1" }],
    });
  });

  it("stays silent when nothing matches the filter", async () => {
    addWatching(registry, "s1", COL, { query: { ownerId: "u1" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [{ _id: "2", ownerId: "u2" }],
    });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("sends the union when one socket holds several filters", async () => {
    addWatching(registry, "s1", COL, { query: { ownerId: "u1" } });
    addWatching(registry, "s1", COL, { query: { ownerId: "u2" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
        { _id: "3", ownerId: "u3" },
      ],
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][1].update).toHaveLength(2);
  });

  it("gives an unfiltered watch everything even alongside a filtered one", async () => {
    addWatching(registry, "s1", COL, { query: { ownerId: "u1" } });
    addWatching(registry, "s1", COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
    });
    expect(mockEmit.mock.calls[0][1].update).toHaveLength(2);
  });

  it("filters per socket rather than globally", async () => {
    addWatching(registry, "s1", COL, { query: { ownerId: "u1" } });
    addWatching(registry, "s2", COL, { query: { ownerId: "u2" } });
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "update",
      data: [
        { _id: "1", ownerId: "u1" },
        { _id: "2", ownerId: "u2" },
      ],
    });
    const bySocket = Object.fromEntries(
      mockTo.mock.calls.map(([id], i) => [id, mockEmit.mock.calls[i][1].update]),
    );
    expect(bySocket.s1).toEqual([{ _id: "1", ownerId: "u1" }]);
    expect(bySocket.s2).toEqual([{ _id: "2", ownerId: "u2" }]);
  });

  it("ignores sockets watching a different collection", async () => {
    addWatching(registry, "s1", "proj1/other", {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "add",
      data: [{ _id: "1" }],
    });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("preserves the action key in the payload", async () => {
    addWatching(registry, "s1", COL, {});
    await sendUpdateCollectionStreamEvent({
      colPath: COL,
      action: "delete",
      data: [{ _id: "1" }],
    });
    expect(mockEmit.mock.calls[0][1]).toHaveProperty("delete");
  });

  it("does not emit for an empty document list", async () => {
    addWatching(registry, "s1", COL, {});
    await sendUpdateCollectionStreamEvent({ colPath: COL, action: "update", data: [] });
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
