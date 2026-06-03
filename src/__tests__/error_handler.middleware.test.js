jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const { errorHandler } = require("../middleware/error_handler.middleware");
const { AppError } = require("../utils/app_error");
const { mockReq, mockRes, mockNext } = require("./helpers/express-mocks");
const Logger = require("../utils/logger");

describe("errorHandler middleware", () => {
  it("should respond with err.statusCode when present", () => {
    const err = new AppError("Bad request", 400);
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("should respond with err.status when present", () => {
    const err = new Error("Forbidden");
    err.status = 403;
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("should default to 500 when no status on error", () => {
    const err = new Error("Unknown");
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("should hide actual message for 500 errors", () => {
    const err = new Error("DB connection failed with secret info");
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.message).toBe("Internal server error");
  });

  it("should return actual error message for non-500 errors", () => {
    const err = new AppError("Validation failed", 400);
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.message).toBe("Validation failed");
  });

  it("should include errors array when err.errors is non-empty", () => {
    const err = new AppError("Bad", 400, ["field1 required", "field2 invalid"]);
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.errors).toEqual(["field1 required", "field2 invalid"]);
  });

  it("should omit errors key when err.errors is empty", () => {
    const err = new AppError("Bad", 400);
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.errors).toBeUndefined();
  });

  it("should work with plain Error instances (status 500)", () => {
    const err = new Error("crash");
    const res = mockRes();
    errorHandler(err, mockReq(), res, mockNext());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].message).toBe("Internal server error");
  });

  it("should call Logger.error", () => {
    const err = new AppError("test error", 422);
    errorHandler(err, mockReq(), mockRes(), mockNext());
    expect(Logger.error).toHaveBeenCalled();
  });
});
