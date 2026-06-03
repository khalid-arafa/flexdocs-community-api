// Centralized error handler - catches unhandled errors from all routes
const Logger = require("../utils/logger");

function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;

  Logger.error(err.message || "Unhandled error", {
    requestId: req.id,
    status,
    method: req.method,
    url: req.originalUrl,
    stack: status === 500 ? err.stack : undefined,
  });

  const message =
    status === 500 ? "Internal server error" : err.message || "Something went wrong";

  const response = { message };
  if (err.errors && err.errors.length > 0) {
    response.errors = err.errors;
  }

  res.status(status).json(response);
}

module.exports = { errorHandler };
