const socketIo = require("socket.io");
const { socketAuth } = require("../middleware/socket_auth.middleware");
const { parseSystemOrigins } = require("../middleware/cors.middleware");
const { createSocketRateLimiter } = require("../middleware/socket_rate_limit.middleware");
const Logger = require("../utils/logger");

let io = null;
function getIO() {
  if (!io) Logger.warn("Socket.IO has not been initialized yet!");
  return io;
}

function socket_connection_init(server) {
  const systemOrigins = parseSystemOrigins();
  const isProduction = process.env.NODE_ENV === "production";
  // In production, require explicit origins; in dev, fall back to wildcard
  const origin =
    systemOrigins.length === 0 ? (isProduction ? false : "*") : systemOrigins;

  io = socketIo(server, {
    cors: { origin, methods: ["GET", "POST"], credentials: true },
    pingInterval: 25000,
    pingTimeout: 20000,
  });
  io.use(socketAuth);
  // Per-socket event rate limiting — bounds event floods from a single socket.
  io.use(createSocketRateLimiter({ maxEvents: 100, windowMs: 60000 }));
  return io;
}

module.exports = {
  socket_connection_init,
  getIO,
};
