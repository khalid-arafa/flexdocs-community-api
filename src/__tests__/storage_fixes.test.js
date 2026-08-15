/**
 * Two storage fixes that are easy to regress:
 *
 * 1. Storage rules are default-DENY everywhere. The socket upload path and the
 *    REST download path used to disagree — the download route allowed a private
 *    file through on a valid project token when the project defined no rules,
 *    while the upload path denied it. Both now deny, and both say *why* when
 *    the project simply has no rules authored, so an operator is not left
 *    debugging a rule set that does not exist.
 *
 * 2. getBucketByName auto-creates a missing bucket and then re-reads it. That
 *    re-read used to be an unconditional recursive call, so a persistently
 *    failing insert recursed forever (stack overflow / hung upload). It is now
 *    a single bounded retry, which is exactly what the concurrent-create race
 *    needs: the loser's insert fails on the duplicate key and the re-read
 *    resolves it to the winner's bucket.
 */

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

jest.mock("fs/promises", () => ({
  mkdir: jest.fn(),
  unlink: jest.fn(),
  rmdir: jest.fn(),
  appendFile: jest.fn(),
  stat: jest.fn(),
}));

jest.mock("../core/storage_service", () => ({ createStorageFile: jest.fn() }));
jest.mock("../utils/file", () => ({ getDownloadableLink: jest.fn() }));
jest.mock("../middleware/storage_rules.middleware", () => ({
  checkStorageRule: jest.fn(),
}));
jest.mock("../middleware/db_rules.middleware", () => ({
  isAdminSocket: jest.fn(),
}));
jest.mock("../sockets/io_connect", () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

const fsp = require("fs/promises");
const Logger = require("../utils/logger");
const { checkStorageRule } = require("../middleware/storage_rules.middleware");
const { isAdminSocket } = require("../middleware/db_rules.middleware");
const { storageSockets, __internals } = require("../sockets/storage.sockets");

const { hasStorageRules, NO_STORAGE_RULES_UPLOAD_MESSAGE } = __internals;

function connectSocket({ sender = null, storageRules } = {}) {
  const socket = {
    id: "sock1",
    project: { code: "proj1", userId: "_system", storageRules },
    sender,
    handlers: {},
    on(event, fn) {
      this.handlers[event] = fn;
    },
    onAny: jest.fn(),
    emit: jest.fn(),
  };
  let onConnection;
  storageSockets({ on: (_event, fn) => (onConnection = fn) });
  onConnection(socket);
  return socket;
}

function emitted(socket, event) {
  const call = socket.emit.mock.calls.find(([name]) => name === event);
  return call && call[1];
}

beforeEach(() => {
  fsp.mkdir.mockResolvedValue(undefined);
  fsp.unlink.mockResolvedValue(undefined);
  fsp.rmdir.mockResolvedValue(undefined);
  isAdminSocket.mockResolvedValue(null);
});

// ── Task 1: default-deny is consistent, and the unconfigured case is legible ──

describe("hasStorageRules", () => {
  it("treats undefined, null and an empty object as unconfigured", () => {
    expect(hasStorageRules(undefined)).toBe(false);
    expect(hasStorageRules(null)).toBe(false);
    expect(hasStorageRules({})).toBe(false);
  });

  it("treats any authored rule as configured", () => {
    expect(hasStorageRules({ "/files": true })).toBe(true);
    expect(hasStorageRules({ "/buckets": { read: false } })).toBe(true);
  });
});

describe("upload:start with no storage rules defined", () => {
  it("denies the upload (default-deny), not allows it", async () => {
    checkStorageRule.mockResolvedValue(false);
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    expect(emitted(socket, "upload:ready")).toBeUndefined();
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
  });

  it("names the missing configuration instead of a generic denial", async () => {
    checkStorageRule.mockResolvedValue(false);
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    const error = emitted(socket, "upload:error");
    expect(error.message).toBe(NO_STORAGE_RULES_UPLOAD_MESSAGE);
    expect(error.message).toMatch(/no storage rules are defined/i);
    expect(error.message).toMatch(/"\/files"/);
  });

  it("logs the denial at warn level with the project code", async () => {
    checkStorageRule.mockResolvedValue(false);
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no storage rules are defined/i),
      expect.objectContaining({ projectCode: "proj1" }),
    );
  });

  it("keeps the generic message when rules exist but deny", async () => {
    checkStorageRule.mockResolvedValue(false);
    const socket = connectSocket({ storageRules: { "/files": { add: false } } });
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    expect(emitted(socket, "upload:error").message).toBe("Upload denied by storage rules");
    expect(Logger.warn).not.toHaveBeenCalled();
  });

  // The production project referenced in the change note: explicit allow-all.
  it("is unaffected by the change when rules explicitly allow everything", async () => {
    checkStorageRule.mockResolvedValue(true);
    const socket = connectSocket({
      storageRules: { "/files": true, "/buckets": true },
    });
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    expect(emitted(socket, "upload:ready")).toEqual({ name: "photo.jpg" });
  });

  it("still lets an admin socket upload with no rules defined", async () => {
    checkStorageRule.mockResolvedValue(false);
    isAdminSocket.mockResolvedValue({ _id: "admin1", roles: ["admin"] });
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    expect(emitted(socket, "upload:ready")).toEqual({ name: "photo.jpg" });
  });
});

// ── Task 2: bounded bucket auto-creation ─────────────────────────────────────

describe("getBucketByName", () => {
  // storage_service is mocked at the top of this file for the socket tests, so
  // load the REAL one in an isolated registry with only its own dependency
  // (db_service) faked.
  let getBucketByName;
  let db;

  beforeEach(() => {
    jest.isolateModules(() => {
      jest.dontMock("../core/storage_service");
      jest.doMock("../core/db_service", () => ({
        getDocument: jest.fn(),
        createDocument: jest.fn(),
        deleteDocument: jest.fn(),
        getManyDocuments: jest.fn(),
        updateDocument: jest.fn(),
        countDocuments: jest.fn(),
      }));
      db = require("../core/db_service");
      ({ getBucketByName } = require("../core/storage_service"));
    });
  });

  afterEach(() => {
    // Restore the file-level mock for the socket suites.
    jest.doMock("../core/storage_service", () => ({ createStorageFile: jest.fn() }));
  });

  const args = { userId: "_system", projectCode: "proj1", bucketName: "images" };

  it("returns an existing bucket without creating anything", async () => {
    db.getDocument.mockResolvedValue({ _id: "b1", name: "images" });
    await expect(getBucketByName(args)).resolves.toEqual({ _id: "b1", name: "images" });
    expect(db.createDocument).not.toHaveBeenCalled();
    expect(db.getDocument).toHaveBeenCalledTimes(1);
  });

  it("creates the bucket on first use and returns it", async () => {
    db.getDocument
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "b1", name: "images" });
    db.createDocument.mockResolvedValue("b1");
    await expect(getBucketByName(args)).resolves.toEqual({ _id: "b1", name: "images" });
    expect(db.createDocument).toHaveBeenCalledTimes(1);
  });

  // The race: a concurrent request won and inserted first, so this request's
  // insert is rejected on the duplicate key (createDocument swallows it and
  // returns null). The single retry must resolve to the winner's bucket.
  it("resolves to the existing bucket when a concurrent create won the race", async () => {
    db.getDocument
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "winner", name: "images" });
    db.createDocument.mockResolvedValue(null); // duplicate key, swallowed
    await expect(getBucketByName(args)).resolves.toEqual({ _id: "winner", name: "images" });
  });

  it("throws a clear error instead of recursing when creation keeps failing", async () => {
    db.getDocument.mockResolvedValue(null);
    db.createDocument.mockResolvedValue(null);
    await expect(getBucketByName(args)).rejects.toThrow(
      /Failed to create or resolve the bucket "images"/,
    );
  });

  // The regression guard: unbounded recursion showed up as an ever-growing
  // number of lookups. Bounded means exactly two reads and one create.
  it("attempts the lookup at most twice", async () => {
    db.getDocument.mockResolvedValue(null);
    db.createDocument.mockResolvedValue(null);
    await expect(getBucketByName(args)).rejects.toThrow();
    expect(db.getDocument).toHaveBeenCalledTimes(2);
    expect(db.createDocument).toHaveBeenCalledTimes(1);
  });
});
