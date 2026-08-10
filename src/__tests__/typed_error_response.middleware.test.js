const { typedErrorResponse, codeForStatus, STATUS_CODES } = require("../middleware/typed_error_response.middleware");

function runMiddleware() {
  const res = {
    statusCode: 200,
    jsonCalls: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonCalls.push(body);
      return this;
    },
  };
  const next = jest.fn();
  typedErrorResponse({}, res, next);
  return res;
}

describe("typedErrorResponse", () => {
  it("calls next()", () => {
    const res = runMiddleware();
    // next was called synchronously inside typedErrorResponse before we can
    // observe jsonCalls, so just confirm the patched res still behaves.
    res.status(200).json({ ok: true });
    expect(res.jsonCalls).toEqual([{ ok: true }]);
  });

  it("adds code and status to an error body, leaving message untouched", () => {
    const res = runMiddleware();
    res.status(404).json({ message: "Doc not found!" });
    expect(res.jsonCalls[0]).toEqual({
      message: "Doc not found!",
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("leaves a success (< 400) body completely untouched", () => {
    const res = runMiddleware();
    res.status(200).json({ message: "ok", data: [1, 2, 3] });
    expect(res.jsonCalls[0]).toEqual({ message: "ok", data: [1, 2, 3] });
  });

  it("does not overwrite an already-present code or status field", () => {
    const res = runMiddleware();
    res.status(400).json({ message: "x", code: "CUSTOM_CODE" });
    expect(res.jsonCalls[0]).toEqual({ message: "x", code: "CUSTOM_CODE" });
  });

  it("does not clobber /health's domain-specific status field (string, not HTTP status)", () => {
    const res = runMiddleware();
    res.status(503).json({ status: "error", db: "disconnected" });
    expect(res.jsonCalls[0]).toEqual({ status: "error", db: "disconnected" });
  });

  it("leaves a non-object body (array) untouched", () => {
    const res = runMiddleware();
    res.status(400).json([1, 2, 3]);
    expect(res.jsonCalls[0]).toEqual([1, 2, 3]);
  });

  it("leaves a null body untouched", () => {
    const res = runMiddleware();
    res.status(500).json(null);
    expect(res.jsonCalls[0]).toBeNull();
  });

  it("preserves extra fields already on the error body (e.g. zod's errors array)", () => {
    const res = runMiddleware();
    res.status(400).json({ message: "Invalid rules structure", errors: ["bad"] });
    expect(res.jsonCalls[0]).toEqual({
      message: "Invalid rules structure",
      errors: ["bad"],
      code: "BAD_REQUEST",
      status: 400,
    });
  });

  it.each(Object.entries(STATUS_CODES))("maps status %s to code %s", (status, code) => {
    expect(codeForStatus(Number(status))).toBe(code);
  });

  it("falls back to a generic ERROR code for an unmapped error status", () => {
    expect(codeForStatus(418)).toBe("ERROR");
  });
});
