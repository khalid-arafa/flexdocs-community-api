const pino = require("pino");

const isProduction = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  ...(isProduction
    ? {
        // Structured JSON to stdout in production (let Docker/logging infra handle it)
      }
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }),
});

// Backwards-compatible wrapper so existing `Logger.log(msg, file)` calls keep working
const Logger = {
  log(msg, filePath) {
    logger.error({ file: filePath }, msg);
  },
  info(msg, meta) {
    logger.info(meta || {}, msg);
  },
  warn(msg, meta) {
    logger.warn(meta || {}, msg);
  },
  error(msg, meta) {
    logger.error(meta || {}, msg);
  },
  debug(msg, meta) {
    logger.debug(meta || {}, msg);
  },
  // expose raw pino instance for middleware / advanced use
  pino: logger,
};

module.exports = Logger;
