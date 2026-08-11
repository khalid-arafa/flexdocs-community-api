// validate env before anything else
const { validateEnv } = require("./utils/validate_env");
validateEnv();

const express = require("express");
const http = require("http");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const validateJsonBody = require("./middleware/validate_json_body.middleware");
const { DatabaseClient, ensureCriticalIndexes } = require("./core/client");
const { socket_connection_init } = require("./sockets/io_connect");
const { startChangeStreams, stopChangeStreams } = require("./core/change_streams");
const { dynamicCors } = require("./middleware/cors.middleware");
const { createAdminUser } = require("./seeds/createAdmin");
const { errorHandler } = require("./middleware/error_handler.middleware");
const { apiLimiter } = require("./middleware/rate_limit.middleware");
const { sanitizeQuery } = require("./middleware/sanitize_query.middleware");
const { typedErrorResponse } = require("./middleware/typed_error_response.middleware");
const { csrfProtection } = require("./middleware/csrf.middleware");
const { requestId } = require("./middleware/request_id.middleware");
const Logger = require("./utils/logger");

const { authSockets } = require("./sockets/auth.sockets");
const { dbSockets } = require("./sockets/db.sockets");
const { storageSockets } = require("./sockets/storage.sockets");

// init app
const app = express();
app.set("trust proxy", 1); // trust first proxy (nginx)
const server = http.createServer(app);

// create default admin if doesn't exist
createAdminUser();

// request correlation ID (first middleware — available to all downstream)
app.use(requestId);

// Patches res.json to add code/status to error bodies. Must run before
// anything that might send its own error response (rate limiter, CORS,
// CSRF, ...) so every one of them is covered too, not just route handlers.
app.use(typedErrorResponse);

// CORS must run before all other middleware so preflight OPTIONS gets proper headers
app.use(dynamicCors);

// security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use(cookieParser());
app.use(validateJsonBody({ limit: "1mb", extended: true }));

// global middleware
app.use(apiLimiter);
app.use(sanitizeQuery);
app.use(csrfProtection);

const io = socket_connection_init(server);

// health check
app.get("/health", async (_req, res) => {
  try {
    await DatabaseClient.db("admin").command({ ping: 1 });
    res.status(200).json({ status: "ok", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// projects routes for auth and dbs and storage
const projectsRoutes = require("./routes/routes");
app.use("/projects", projectsRoutes);

// public routes (verify, reset-password)
const publicRoutes = require("./routes/public.routes");
app.use("/", publicRoutes);

// first-run setup wizard (creates the single admin; self-locks once done)
const setupRoutes = require("./routes/setup.routes");
app.use("/", setupRoutes);

// users on the system
const systemRoutes = require("./system/routes");
app.use("/", systemRoutes);

// sockets
authSockets(io); // auth sockets
dbSockets(io); // databases sockets
storageSockets(io); // storage sockets

// centralized error handler (must be last)
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3000;
DatabaseClient.connect().then(async () => {
  await ensureCriticalIndexes();
  // Probes for change-stream support and starts watching only if the
  // deployment has it. Deliberately not awaited and never fatal: a standalone
  // MongoDB simply keeps realtime on emit-after-write (see
  // core/change_streams.js), and the server must come up either way.
  startChangeStreams().catch((error) => {
    Logger.error("Change stream: startup failed", { error: error.message });
  });
  server.listen(PORT, () => {
    Logger.info(`Server running on port ${PORT}`);
  });
});

// graceful shutdown
function shutdown(signal) {
  Logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    Logger.info("HTTP server closed");
    io.close(async () => {
      Logger.info("Socket.IO closed");
      // Before closing the client: the stream holds a cursor on it, and
      // closing the client under it logs a spurious failure.
      await stopChangeStreams();
      DatabaseClient.close().then(() => {
        Logger.info("MongoDB connection closed");
        process.exit(0);
      });
    });
  });
  // force exit after 30s if drain stalls
  setTimeout(() => {
    Logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 30000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  Logger.error("Unhandled promise rejection", { error: reason?.message || reason, stack: reason?.stack });
});
