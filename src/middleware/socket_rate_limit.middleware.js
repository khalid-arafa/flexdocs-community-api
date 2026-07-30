/**
 * Per-socket sliding-window rate limiter.
 *
 * Two independent budgets share one window:
 *
 *   - Control events (subscribe, unsubscribe, token, upload handshake) are
 *     counted per packet against `maxEvents`.
 *   - Events named in `exemptEvents` carry bulk payloads and are counted in
 *     bytes against `maxBytes` instead. Counting those per packet throttled on
 *     payload chunking rather than on load: at 64KB per chunk a 100-events/60s
 *     budget truncated any upload over ~6.4MB — far below the advertised 50MB
 *     file limit — and silently dropped the trailing `upload:done` too.
 *
 * Exceeding either budget drops the packet and emits an error to the sender.
 */

function valueBytes(value) {
  if (value == null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += valueBytes(item);
    return total;
  }
  if (typeof value === "object") {
    let total = 0;
    for (const key of Object.keys(value)) {
      total += key.length + valueBytes(value[key]);
    }
    return total;
  }
  return 0;
}

/** Best-effort byte size of a packet's arguments, for byte-budget accounting. */
function payloadBytes(packet) {
  const args = Array.isArray(packet?.data) ? packet.data.slice(1) : [];
  let total = 0;
  for (const arg of args) total += valueBytes(arg);
  return total;
}

function createSocketRateLimiter({
  maxEvents = 60,
  windowMs = 60000,
  exemptEvents = [],
  maxBytes = 0,
} = {}) {
  const buckets = new Map(); // socketId → { count, bytes, resetAt }
  const exempt = new Set(exemptEvents);

  return function rateLimitSocket(socket, next) {
    const originalOnevent = socket.onevent;

    socket.onevent = function (packet) {
      const id = socket.id;
      const now = Date.now();
      let bucket = buckets.get(id);

      if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, bytes: 0, resetAt: now + windowMs };
        buckets.set(id, bucket);
      }

      const eventName = Array.isArray(packet?.data) ? packet.data[0] : undefined;

      if (exempt.has(eventName)) {
        if (maxBytes > 0) {
          bucket.bytes += payloadBytes(packet);
          if (bucket.bytes > maxBytes) {
            return socket.emit("error", {
              message: "Data rate limit exceeded, slow down",
            });
          }
        }
      } else {
        bucket.count++;
        if (bucket.count > maxEvents) {
          return socket.emit("error", {
            message: "Rate limit exceeded, slow down",
          });
        }
      }

      originalOnevent.call(socket, packet);
    };

    socket.on("disconnect", () => {
      buckets.delete(socket.id);
    });

    next();
  };
}

module.exports = { createSocketRateLimiter };
