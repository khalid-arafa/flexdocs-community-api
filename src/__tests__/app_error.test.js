const { AppError } = require("../utils/app_error");

describe("AppError", () => {
  it("should be an instance of Error", () => {
    const err = new AppError("test");
    expect(err).toBeInstanceOf(Error);
  });

  it("should set message from constructor", () => {
    const err = new AppError("Something failed");
    expect(err.message).toBe("Something failed");
  });

  it("should default statusCode to 400", () => {
    const err = new AppError("test");
    expect(err.statusCode).toBe(400);
  });

  it("should accept custom statusCode", () => {
    const err = new AppError("not found", 404);
    expect(err.statusCode).toBe(404);
  });

  it("should default errors to empty array", () => {
    const err = new AppError("test");
    expect(err.errors).toEqual([]);
  });

  it("should accept custom errors array", () => {
    const errs = ["field1 is required", "field2 is invalid"];
    const err = new AppError("Validation failed", 400, errs);
    expect(err.errors).toEqual(errs);
  });

  it("should have a stack trace", () => {
    const err = new AppError("test");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("app_error.test.js");
  });
});
