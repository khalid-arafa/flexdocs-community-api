/**
 * Per-socket sliding-window rate limiter.
 *
 * Tracks event counts per socket using a simple token-bucket approach.
 * When a socket exceeds `maxEvents` in `windowMs`, further events
 * receive an "error" emit and are dropped until the window resets.
 */
function createSocketRateLimiter({ maxEvents = 60, windowMs = 60000 } = {}) {
  const buckets = new Map(); // socketId → { count, resetAt }

  return function rateLimitSocket(socket, next) {
    const originalOnevent = socket.onevent;

    socket.onevent = function (packet) {
      const id = socket.id;
      const now = Date.now();
      let bucket = buckets.get(id);

      if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(id, bucket);
      }

      bucket.count++;
      if (bucket.count > maxEvents) {
        return socket.emit("error", {
          message: "Rate limit exceeded, slow down",
        });
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
