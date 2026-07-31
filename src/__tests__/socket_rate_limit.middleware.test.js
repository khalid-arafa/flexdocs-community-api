/**
 * Regression tests for the per-socket rate limiter.
 *
 * The upload path chunks at 64KB per `upload:chunk`. Counting those packets
 * against the 100-events/60s control budget capped uploads at ~6.4MB — well
 * under the 50MB advertised limit — and dropped the trailing `upload:done`
 * along with the chunks.
 */

const {
  createSocketRateLimiter,
} = require("../middleware/socket_rate_limit.middleware");

function makeSocket() {
  const handlers = {};
  const socket = {
    id: "sock1",
    delivered: [],
    errors: [],
    onevent(packet) {
      // Mirrors socket.io: a malformed packet reaches the handler rather than
      // being swallowed by the limiter.
      socket.delivered.push(packet?.data?.[0]);
    },
    emit(event, payload) {
      if (event === "error") socket.errors.push(payload);
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    trigger(event) {
      handlers[event]?.();
    },
  };
  return socket;
}

function attach(options) {
  const socket = makeSocket();
  createSocketRateLimiter(options)(socket, () => {});
  return socket;
}

function send(socket, event, ...args) {
  socket.onevent({ data: [event, ...args] });
}

describe("control-event budget", () => {
  it("passes events through under the limit", () => {
    const socket = attach({ maxEvents: 3, windowMs: 60000 });
    for (let i = 0; i < 3; i++) send(socket, "watch-col-updates", { col: "c" });
    expect(socket.delivered).toHaveLength(3);
    expect(socket.errors).toHaveLength(0);
  });

  it("drops events past the limit and reports an error", () => {
    const socket = attach({ maxEvents: 2, windowMs: 60000 });
    for (let i = 0; i < 4; i++) send(socket, "watch-col-updates", { col: "c" });
    expect(socket.delivered).toHaveLength(2);
    expect(socket.errors.length).toBeGreaterThan(0);
    expect(socket.errors[0].message).toMatch(/rate limit/i);
  });

  it("resets the budget once the window elapses", () => {
    jest.useFakeTimers();
    try {
      const socket = attach({ maxEvents: 1, windowMs: 1000 });
      send(socket, "a");
      send(socket, "a");
      expect(socket.delivered).toHaveLength(1);
      jest.advanceTimersByTime(1500);
      send(socket, "a");
      expect(socket.delivered).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("releases the bucket on disconnect", () => {
    const socket = attach({ maxEvents: 1, windowMs: 60000 });
    send(socket, "a");
    expect(() => socket.trigger("disconnect")).not.toThrow();
  });
});

describe("exempt bulk events", () => {
  const CHUNK = 64 * 1024;
  const chunk = () => ({ name: "f.bin", chunk: new Uint8Array(CHUNK) });

  it("does not count exempt events against the control budget", () => {
    const socket = attach({
      maxEvents: 5,
      windowMs: 60000,
      exemptEvents: ["upload:chunk"],
      maxBytes: 100 * 1024 * 1024,
    });
    for (let i = 0; i < 500; i++) send(socket, "upload:chunk", chunk());
    expect(socket.delivered).toHaveLength(500);
    expect(socket.errors).toHaveLength(0);
  });

  // The concrete regression: a 50MB file is 800 chunks at 64KB.
  it("carries a full 50MB upload without truncating", () => {
    const socket = attach({
      maxEvents: 100,
      windowMs: 60000,
      exemptEvents: ["upload:chunk"],
      maxBytes: 100 * 1024 * 1024,
    });
    const chunks = Math.ceil((50 * 1024 * 1024) / CHUNK);
    for (let i = 0; i < chunks; i++) send(socket, "upload:chunk", chunk());
    send(socket, "upload:done", { name: "f.bin" });

    expect(socket.delivered.filter((e) => e === "upload:chunk")).toHaveLength(chunks);
    expect(socket.delivered).toContain("upload:done");
    expect(socket.errors).toHaveLength(0);
  });

  it("still bounds exempt events by total bytes", () => {
    const socket = attach({
      maxEvents: 100,
      windowMs: 60000,
      exemptEvents: ["upload:chunk"],
      maxBytes: CHUNK * 3,
    });
    for (let i = 0; i < 10; i++) send(socket, "upload:chunk", chunk());
    expect(socket.delivered.length).toBeLessThan(10);
    expect(socket.errors[0].message).toMatch(/data rate limit/i);
  });

  it("leaves the control budget usable after a byte overrun", () => {
    const socket = attach({
      maxEvents: 5,
      windowMs: 60000,
      exemptEvents: ["upload:chunk"],
      maxBytes: CHUNK,
    });
    for (let i = 0; i < 10; i++) send(socket, "upload:chunk", chunk());
    send(socket, "watch-col-updates", { col: "c" });
    expect(socket.delivered).toContain("watch-col-updates");
  });

  it("does not meter bytes when maxBytes is disabled", () => {
    const socket = attach({
      maxEvents: 2,
      windowMs: 60000,
      exemptEvents: ["upload:chunk"],
      maxBytes: 0,
    });
    for (let i = 0; i < 50; i++) send(socket, "upload:chunk", chunk());
    expect(socket.delivered).toHaveLength(50);
  });

  it("counts a non-exempt event normally even with a large payload", () => {
    const socket = attach({
      maxEvents: 1,
      windowMs: 60000,
      exemptEvents: ["upload:chunk"],
      maxBytes: 100 * 1024 * 1024,
    });
    send(socket, "some-event", chunk());
    send(socket, "some-event", chunk());
    expect(socket.delivered).toHaveLength(1);
  });

  it("tolerates a malformed packet without throwing", () => {
    const socket = attach({ maxEvents: 10, windowMs: 60000, exemptEvents: ["x"] });
    expect(() => socket.onevent({})).not.toThrow();
    expect(() => socket.onevent({ data: [] })).not.toThrow();
  });
});

describe("wiring", () => {
  it("exempts upload:chunk with a byte budget in the shipped config", () => {
    const { socketLimits } = require("../constants");
    expect(socketLimits.rateLimitExemptEvents).toContain("upload:chunk");
    expect(socketLimits.maxBytesPerWindow).toBeGreaterThan(
      require("../constants").uploadLimits.maxFileSize,
    );
  });
});
