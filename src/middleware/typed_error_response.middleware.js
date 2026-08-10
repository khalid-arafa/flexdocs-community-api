// C10 (additive half of B2): every error handler across the 67 routes
// returns `res.status(N).json({ message: "..." })` with no machine-readable
// code, so both SDKs are reduced to string-matching `message` — brittle, and
// blocks any future typed-exception work (see the Flutter SDK's C14).
//
// Rather than touching all ~138 call sites individually (real risk of a typo
// changing message text, and it would still miss any call site written
// later), this wraps res.json ONCE, globally, and adds `code`/`status` to any
// JSON body already destined for an error status. Every existing `message`
// string is untouched — this only ever ADDS keys, and only on responses that
// don't already define them (so /health's `{ status: "ok"|"error" }`, a
// domain field unrelated to HTTP status, is left alone rather than clobbered).
const STATUS_CODES = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE_ENTITY",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
};

function codeForStatus(statusCode) {
  return STATUS_CODES[statusCode] || "ERROR";
}

function typedErrorResponse(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (
      res.statusCode >= 400 &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      body.code === undefined &&
      body.status === undefined
    ) {
      body = { ...body, code: codeForStatus(res.statusCode), status: res.statusCode };
    }
    return originalJson(body);
  };
  next();
}

module.exports = { typedErrorResponse, codeForStatus, STATUS_CODES };
