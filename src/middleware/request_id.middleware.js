const crypto = require("crypto");

const REQUEST_ID_HEADER = "x-request-id";

function requestId(req, res, next) {
  // Use client-provided ID if present (for distributed tracing), otherwise generate one
  const id = req.headers[REQUEST_ID_HEADER] || crypto.randomUUID();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

module.exports = { requestId };
