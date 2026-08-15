// validate env before anything else
const { validateEnv } = require("./utils/validate_env");
validateEnv();

const express = require("express");
const http = require("http");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const validateJsonBody = require("./middleware/validate_json_body.middleware");
const { DatabaseClient, ensureCriticalIndexes, connectWithRetry } = require("./core/client");
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
//
// connectWithRetry (core/client.js) rides out a Mongo that is still coming up
// alongside us; the .catch below is what happens when it never does. Without
// it, the rejection landed in the unhandledRejection handler, which only
// logged — server.listen was never reached, nothing exited, and the container
// sat there alive-but-not-listening forever, so Docker's `restart:
// unless-stopped` never fired. A process that cannot serve must die loudly.
const PORT = process.env.PORT || 3000;
connectWithRetry()
  .then(async () => {
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
  })
  .catch((error) => {
    // Covers ensureCriticalIndexes() too: if the critical unique indexes cannot
    // be established, coming up anyway would let duplicate project codes and
    // duplicate admin emails through.
    Logger.error("Fatal: startup failed, exiting so the supervisor restarts us", {
      error: error?.message || error,
      stack: error?.stack,
    });
    process.exit(1);
  });

// graceful shutdown
const DRAIN_TIMEOUT_MS = 30000;
// A crashed process is already in an unknown state, so it gets a much shorter
// leash than a deliberate SIGTERM: attempt the same drain, but do not let a
// wedged one keep a broken process serving traffic for half a minute.
const FATAL_DRAIN_TIMEOUT_MS = 5000;

let shuttingDown = false;

function shutdown(signal, { exitCode = 0, forceAfterMs = DRAIN_TIMEOUT_MS } = {}) {
  if (shuttingDown) {
    // A second signal (an impatient Ctrl-C, or a fatal error raised while the
    // first drain is in flight) means stop now, not start a second drain that
    // would double-close everything. `|| 1` because an abandoned drain is not a
    // clean exit even when the reason for it was — the same reading the force
    // timeout below has always taken.
    Logger.warn(`${signal} received while already shutting down — exiting now`);
    process.exit(exitCode || 1);
  }
  shuttingDown = true;

  Logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    Logger.info("HTTP server closed");
    io.close(async () => {
      Logger.info("Socket.IO closed");
      // Before closing the client: the stream holds a cursor on it, and
      // closing the client under it logs a spurious failure.
      await stopChangeStreams();
      DatabaseClient.close()
        .then(() => {
          Logger.info("MongoDB connection closed");
        })
        // A client that will not close cleanly must not strand the shutdown on
        // the force timer — the exit code is what the supervisor reads, and it
        // should still reflect why we are going down.
        .catch((error) => {
          Logger.warn("MongoDB connection close failed", { error: error.message });
        })
        .finally(() => process.exit(exitCode));
    });
  });
  // force exit if the drain stalls
  setTimeout(() => {
    Logger.error("Forced shutdown after timeout");
    process.exit(exitCode || 1);
  }, forceAfterMs);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// The process is not trustworthy after this point — an exception escaped every
// handler, so some request, socket or timer callback stopped halfway through
// with whatever it was mutating left half-mutated. Node's own default is to
// exit; a handler that logged and continued would be strictly worse than no
// handler at all. Drain briefly (in-flight responses, socket buffers) and exit
// non-zero so the supervisor restarts us into a known-good state.
process.on("uncaughtException", (error) => {
  Logger.error("Fatal: uncaught exception", {
    error: error?.message || error,
    stack: error?.stack,
  });
  shutdown("uncaughtException", { exitCode: 1, forceAfterMs: FATAL_DRAIN_TIMEOUT_MS });
});

// Deliberately NOT fatal by default, which is the opposite of the call made for
// uncaughtException above. The reason is the shape of this codebase rather than
// a difference in principle:
//
//   - Express 4 does not forward a rejected async handler or middleware. It
//     does not crash today; the request simply hangs and the rejection surfaces
//     here. There are dozens of async handlers, and any one of them missing a
//     try/catch becomes a REMOTE crash switch the moment this exits — a Mongo
//     hiccup on one request would take down every other in-flight request too.
//   - Socket.IO likewise does not catch a rejected async event listener
//     (sockets/db.sockets.js, storage.sockets.js), and those listeners are
//     driven by client-supplied payloads.
//   - sockets/storage.sockets.js chains fire-and-forget filesystem work onto
//     upload.writeChain and deletes the upload from activeUploads in the same
//     breath, so the tail of that chain sometimes has nobody left to await it.
//
// Turning all of that fatal blind would convert latent, per-request bugs into a
// whole-process crash loop. So: log by default (today's behavior), and let an
// operator who wants strict fail-fast semantics opt in with
// EXIT_ON_UNHANDLED_REJECTION=true once their deployment is known clean. When
// off, this is still the loudest signal that one of the paths above is missing
// a catch — treat every line it prints as a bug to fix, not as noise.
const EXIT_ON_UNHANDLED_REJECTION =
  String(process.env.EXIT_ON_UNHANDLED_REJECTION).toLowerCase() === "true";

process.on("unhandledRejection", (reason) => {
  Logger.error("Unhandled promise rejection", { error: reason?.message || reason, stack: reason?.stack });
  if (EXIT_ON_UNHANDLED_REJECTION) {
    shutdown("unhandledRejection", { exitCode: 1, forceAfterMs: FATAL_DRAIN_TIMEOUT_MS });
  }
});
