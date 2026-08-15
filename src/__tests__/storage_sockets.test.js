/**
 * Tests for the storage socket handlers and the room registry.
 *
 * `upload:done` / `upload:cancel` carry a bare filename from the JS SDK and a
 * `{ name }` object from the Flutter SDK; indexing `activeUploads` with the raw
 * payload meant Flutter uploads were written to disk in full and then silently
 * never finalized. The handlers are only reachable through a socket.io
 * connection callback, so they are driven here with a fake io/socket pair.
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

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock("../sockets/io_connect", () => ({ getIO: () => ({ to: mockTo }) }));

const fsp = require("fs/promises");
const { createStorageFile } = require("../core/storage_service");
const { getDownloadableLink } = require("../utils/file");
const { checkStorageRule } = require("../middleware/storage_rules.middleware");
const { isAdminSocket } = require("../middleware/db_rules.middleware");
const { uploadLimits } = require("../constants");
const {
  storageSockets,
  sendStorageSocketEvent,
  __internals,
} = require("../sockets/storage.sockets");

const {
  files_room: rooms,
  uploadName,
  discardUpload,
  getStorageRoomName,
  getStorageSocketsByRoom,
  addSocketToStorageRoom,
  removeStorageSocketFromRoom,
} = __internals;

/** Captures the handlers `storageSockets` registers for one connection. */
function connectSocket({ sender = null, storageRules, storageRealtimeCheck } = {}) {
  const socket = {
    id: "sock1",
    project: { code: "proj1", userId: "_system", storageRules, storageRealtimeCheck },
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
  for (const key of Object.keys(rooms)) delete rooms[key];
  mockEmit.mockClear();
  mockTo.mockClear();
  fsp.mkdir.mockResolvedValue(undefined);
  fsp.unlink.mockResolvedValue(undefined);
  fsp.rmdir.mockResolvedValue(undefined);
  fsp.appendFile.mockResolvedValue(undefined);
  fsp.stat.mockResolvedValue({ size: 42 });
  checkStorageRule.mockResolvedValue(true);
  isAdminSocket.mockResolvedValue(null);
  createStorageFile.mockResolvedValue({ _id: "file-1", name: "photo" });
  getDownloadableLink.mockReturnValue("http://localhost/files/file-1");
});

describe("uploadName", () => {
  it("accepts the JS SDK's bare filename", () => {
    expect(uploadName("photo.jpg")).toBe("photo.jpg");
  });

  it("accepts the Flutter SDK's { name } object", () => {
    expect(uploadName({ name: "photo.jpg" })).toBe("photo.jpg");
  });

  it("returns undefined for a payload carrying no usable name", () => {
    expect(uploadName(undefined)).toBeUndefined();
    expect(uploadName(null)).toBeUndefined();
    expect(uploadName({})).toBeUndefined();
    expect(uploadName({ name: 123 })).toBeUndefined();
  });
});

describe("discardUpload", () => {
  it("removes the file and then its directory", async () => {
    await discardUpload({ filePath: "/tmp/uploads/abc/org.jpg" });
    expect(fsp.unlink).toHaveBeenCalledWith("/tmp/uploads/abc/org.jpg");
    expect(fsp.rmdir).toHaveBeenCalledWith("/tmp/uploads/abc");
  });

  it("ignores what is already gone", async () => {
    fsp.unlink.mockRejectedValue(new Error("ENOENT"));
    fsp.rmdir.mockRejectedValue(new Error("ENOENT"));
    await expect(
      discardUpload({ filePath: "/tmp/uploads/abc/org.jpg" }),
    ).resolves.toBeUndefined();
  });
});

describe("storage room registry", () => {
  it("names a room after the project", () => {
    expect(getStorageRoomName("proj1")).toBe("proj1-storage");
  });

  it("returns an empty list for a project nobody watches", () => {
    expect(getStorageSocketsByRoom("proj1")).toEqual([]);
  });

  it("adds a socket once, however many times it subscribes", () => {
    addSocketToStorageRoom({ projectCode: "proj1", id: "s1" });
    addSocketToStorageRoom({ projectCode: "proj1", id: "s1" });
    addSocketToStorageRoom({ projectCode: "proj1", id: "s2" });
    expect(getStorageSocketsByRoom("proj1")).toEqual(["s1", "s2"]);
  });

  it("drops the room once its last socket leaves", () => {
    addSocketToStorageRoom({ projectCode: "proj1", id: "s1" });
    removeStorageSocketFromRoom({ projectCode: "proj1", id: "s1" });
    expect(rooms).not.toHaveProperty("proj1-storage");
  });

  it("is a no-op when removing an unknown socket", () => {
    addSocketToStorageRoom({ projectCode: "proj1", id: "s1" });
    removeStorageSocketFromRoom({ projectCode: "proj1", id: "nope" });
    expect(getStorageSocketsByRoom("proj1")).toEqual(["s1"]);
  });

  it("keeps projects isolated", () => {
    addSocketToStorageRoom({ projectCode: "proj1", id: "s1" });
    addSocketToStorageRoom({ projectCode: "proj2", id: "s2" });
    expect(getStorageSocketsByRoom("proj1")).toEqual(["s1"]);
    expect(getStorageSocketsByRoom("proj2")).toEqual(["s2"]);
  });
});

describe("sendStorageSocketEvent", () => {
  it("emits to every socket watching the project", () => {
    addSocketToStorageRoom({ projectCode: "proj1", id: "s1" });
    addSocketToStorageRoom({ projectCode: "proj1", id: "s2" });
    sendStorageSocketEvent({ projectCode: "proj1", add: [{ _id: "f1" }] });
    expect(mockTo.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"]);
    expect(mockEmit).toHaveBeenCalledWith("proj1-storage", {
      add: [{ _id: "f1" }],
      update: undefined,
      delete: null,
    });
  });

  it("stays silent when nobody watches the project", () => {
    sendStorageSocketEvent({ projectCode: "proj1", add: [{ _id: "f1" }] });
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe("upload:start", () => {
  it("registers the upload and acknowledges it", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    expect(emitted(socket, "upload:ready")).toEqual({ name: "photo.jpg" });
    expect(socket.activeUploads["photo.jpg"]).toBeDefined();
  });

  it("rejects a missing or blank file name", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "   " });
    expect(emitted(socket, "upload:error").message).toBe("File name is required");
  });

  it("rejects a name containing path separators", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "../../etc/passwd" });
    expect(emitted(socket, "upload:error").message).toMatch(/path separators/);
  });

  it("rejects an over-long name", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({
      name: "a".repeat(uploadLimits.maxFileNameLength + 1) + ".txt",
    });
    expect(emitted(socket, "upload:error").message).toMatch(/must not exceed/);
  });

  it("rejects a blocked extension", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "payload.exe" });
    expect(emitted(socket, "upload:error").message).toBe("File type .exe is not allowed");
  });

  it("rejects a declared size over the ceiling", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({
      name: "big.jpg",
      size: uploadLimits.maxFileSize + 1,
    });
    expect(emitted(socket, "upload:error").message).toMatch(/File size must not exceed/);
  });

  // The project must actually define rules here: a project with NO rules at
  // all is now reported as a configuration gap with its own message (covered
  // in storage_fixes.test.js), not as a rule saying no.
  it("rejects an upload the project's storage rules deny", async () => {
    checkStorageRule.mockResolvedValue(false);
    const socket = connectSocket({ storageRules: { "/files": { add: false } } });
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    expect(emitted(socket, "upload:error").message).toBe("Upload denied by storage rules");
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
  });

  it("allows an admin socket to upload even when storage rules would deny it", async () => {
    checkStorageRule.mockResolvedValue(false);
    isAdminSocket.mockResolvedValue({ _id: "admin1", roles: ["admin"] });
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    expect(emitted(socket, "upload:ready")).toEqual({ name: "photo.jpg" });
  });

  it("caps concurrent uploads per socket", async () => {
    const socket = connectSocket();
    for (let i = 0; i < 10; i++) {
      await socket.handlers["upload:start"]({ name: `photo${i}.jpg` });
    }
    await socket.handlers["upload:start"]({ name: "photo10.jpg" });
    expect(emitted(socket, "upload:error").message).toMatch(/Too many concurrent uploads/);
  });
});

describe("upload:chunk", () => {
  it("appends the chunk and reports progress", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    socket.handlers["upload:chunk"]({ name: "photo.jpg", chunk: [1, 2, 3] });
    await socket.activeUploads["photo.jpg"].writeChain;
    expect(fsp.appendFile).toHaveBeenCalledTimes(1);
    expect(emitted(socket, "upload:progress")).toEqual({ name: "photo.jpg", received: true });
  });

  it("rejects a chunk for an upload that was never started", () => {
    const socket = connectSocket();
    socket.handlers["upload:chunk"]({ name: "ghost.jpg", chunk: [1] });
    expect(emitted(socket, "upload:error").message).toBe("No file upload initiated");
  });

  it("aborts the upload once the byte ceiling is passed", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    const upload = socket.activeUploads["photo.jpg"];
    upload.bytesReceived = uploadLimits.maxFileSize;
    socket.handlers["upload:chunk"]({ name: "photo.jpg", chunk: [1] });
    await upload.writeChain;
    expect(emitted(socket, "upload:error").message).toMatch(/File exceeds maximum size/);
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
    expect(fsp.unlink).toHaveBeenCalled();
  });
});

describe("upload:done", () => {
  it("finalizes an upload named by a bare string", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    await socket.handlers["upload:done"]("photo.jpg");
    expect(createStorageFile).toHaveBeenCalledTimes(1);
    expect(emitted(socket, "upload:complete")).toMatchObject({
      name: "photo.jpg",
      url: "http://localhost/files/file-1",
      size: 42,
    });
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
  });

  // The Flutter regression: the payload is an object, not a string.
  it("finalizes an upload named by a { name } object", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    await socket.handlers["upload:done"]({ name: "photo.jpg" });
    expect(createStorageFile).toHaveBeenCalledTimes(1);
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
  });

  it("strips the extension from the stored file name", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    await socket.handlers["upload:done"]("photo.jpg");
    expect(createStorageFile.mock.calls[0][0].fileInfo.name).toBe("photo");
  });

  it("records the authenticated uploader", async () => {
    const socket = connectSocket({ sender: { _id: { toString: () => "u1" } } });
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    await socket.handlers["upload:done"]("photo.jpg");
    expect(createStorageFile.mock.calls[0][0].uploadedBy).toBe("u1");
  });

  it("ignores a payload with no matching upload", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:done"]({ name: "ghost.jpg" });
    expect(createStorageFile).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("reports failure and discards the file when the record cannot be saved", async () => {
    createStorageFile.mockResolvedValue(false);
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    await socket.handlers["upload:done"]("photo.jpg");
    expect(emitted(socket, "upload:complete")).toBeUndefined();
    expect(emitted(socket, "upload:error").message).toBe("Failed to complete upload");
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
  });

  it("reports failure when a queued write errored", async () => {
    fsp.appendFile.mockRejectedValue(new Error("ENOSPC"));
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    socket.handlers["upload:chunk"]({ name: "photo.jpg", chunk: [1, 2, 3] });
    await socket.handlers["upload:done"]("photo.jpg");
    expect(createStorageFile).not.toHaveBeenCalled();
    expect(emitted(socket, "upload:error").message).toBe("Failed to complete upload");
  });

  it("notifies bucket watchers of the new file", async () => {
    addSocketToStorageRoom({ projectCode: "proj1", id: "watcher" });
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg", bucket: "b1" });
    await socket.handlers["upload:done"]("photo.jpg");
    expect(mockTo).toHaveBeenCalledWith("watcher");
    expect(mockEmit).toHaveBeenCalledWith("proj1-storage", {
      add: [{ _id: "file-1", name: "photo" }],
      update: undefined,
      delete: null,
    });
  });
});

describe("upload:cancel", () => {
  it("discards a partial upload named by a bare string", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    const upload = socket.activeUploads["photo.jpg"];
    socket.handlers["upload:cancel"]("photo.jpg");
    await upload.writeChain;
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
    expect(emitted(socket, "upload:cancelled")).toEqual({ name: "photo.jpg" });
    expect(fsp.unlink).toHaveBeenCalledWith(upload.filePath);
  });

  it("discards a partial upload named by a { name } object", async () => {
    const socket = connectSocket();
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    const upload = socket.activeUploads["photo.jpg"];
    socket.handlers["upload:cancel"]({ name: "photo.jpg" });
    await upload.writeChain;
    expect(socket.activeUploads["photo.jpg"]).toBeUndefined();
    expect(fsp.unlink).toHaveBeenCalledWith(upload.filePath);
  });

  it("ignores a cancel for an unknown upload", async () => {
    const socket = connectSocket();
    socket.handlers["upload:cancel"]("ghost.jpg");
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe("watch-buckets and disconnect", () => {
  it("joins and leaves the project's storage room", async () => {
    const socket = connectSocket();
    await socket.handlers["watch-buckets"]({});
    expect(getStorageSocketsByRoom("proj1")).toEqual(["sock1"]);
    await socket.handlers["stop-watch-buckets"]({});
    expect(getStorageSocketsByRoom("proj1")).toEqual([]);
  });

  it("joins the room with no rule check when storageRealtimeCheck is off (default)", async () => {
    checkStorageRule.mockResolvedValue(false);
    const socket = connectSocket();
    await socket.handlers["watch-buckets"]({});
    expect(getStorageSocketsByRoom("proj1")).toEqual(["sock1"]);
    expect(checkStorageRule).not.toHaveBeenCalled();
  });

  it("denies watch-buckets when storageRealtimeCheck is on and storage rules deny", async () => {
    checkStorageRule.mockResolvedValue(false);
    const socket = connectSocket({ storageRealtimeCheck: true });
    await socket.handlers["watch-buckets"]({});
    expect(emitted(socket, "error")).toBe("Unauthorized");
    expect(getStorageSocketsByRoom("proj1")).toEqual([]);
  });

  it("allows watch-buckets when storageRealtimeCheck is on and storage rules allow", async () => {
    checkStorageRule.mockResolvedValue(true);
    const socket = connectSocket({ storageRealtimeCheck: true });
    await socket.handlers["watch-buckets"]({});
    expect(getStorageSocketsByRoom("proj1")).toEqual(["sock1"]);
  });

  it("lets an admin socket join watch-buckets even when storageRealtimeCheck denies", async () => {
    checkStorageRule.mockResolvedValue(false);
    isAdminSocket.mockResolvedValue({ _id: "admin1", roles: ["admin"] });
    const socket = connectSocket({ storageRealtimeCheck: true });
    await socket.handlers["watch-buckets"]({});
    expect(getStorageSocketsByRoom("proj1")).toEqual(["sock1"]);
  });

  it("discards in-flight uploads and leaves the room on disconnect", async () => {
    const socket = connectSocket();
    await socket.handlers["watch-buckets"]({});
    await socket.handlers["upload:start"]({ name: "photo.jpg" });
    const upload = socket.activeUploads["photo.jpg"];
    socket.handlers["disconnect"]();
    await upload.writeChain;
    expect(socket.activeUploads).toEqual({});
    expect(fsp.unlink).toHaveBeenCalledWith(upload.filePath);
    expect(getStorageSocketsByRoom("proj1")).toEqual([]);
  });
});
