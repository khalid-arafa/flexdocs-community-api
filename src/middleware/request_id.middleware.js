const crypto = require("crypto");

const REQUEST_ID_HEADER = "x-request-id";

// Only safe, bounded characters are accepted from the client-supplied header.
// A raw header value is reflected into the response and written to logs, so an
// unsanitized value enables log injection / header splitting. Anything that
// doesn't match (or is too long) is replaced with a freshly generated UUID.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function requestId(req, res, next) {
  // Use client-provided ID if present (for distributed tracing), otherwise generate one
  const provided = req.headers[REQUEST_ID_HEADER];
  const id = typeof provided === "string" && SAFE_ID.test(provided)
    ? provided
    : crypto.randomUUID();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

module.exports = { requestId };
