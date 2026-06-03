const { z } = require("zod");
const { zodValidate } = require("../middleware/zod_validate.middleware");
const { mockReq, mockRes, mockNext } = require("./helpers/express-mocks");

const testSchema = z.object({
  name: z.string().min(1, "Name is required"),
  age: z.number().int().min(0).optional(),
});

describe("zodValidate middleware", () => {
  let middleware;

  beforeEach(() => {
    middleware = zodValidate(testSchema);
  });

  describe("when body is valid", () => {
    it("should call next() with no arguments", () => {
      const req = mockReq({ body: { name: "John" } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should replace req.body with parsed data", () => {
      const req = mockReq({ body: { name: "John", age: 25 } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(req.body).toEqual({ name: "John", age: 25 });
    });

    it("should strip extra fields not in schema", () => {
      const req = mockReq({ body: { name: "John", extraField: "should be removed" } });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(req.body).toEqual({ name: "John" });
      expect(req.body.extraField).toBeUndefined();
    });
  });

  describe("when body is invalid", () => {
    it("should respond with status 400", () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should respond with message and errors array", () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      const jsonArg = res.json.mock.calls[0][0];
      expect(jsonArg).toHaveProperty("message");
      expect(jsonArg).toHaveProperty("errors");
      expect(Array.isArray(jsonArg.errors)).toBe(true);
    });

    it("should set message to the first error", () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      const jsonArg = res.json.mock.calls[0][0];
      expect(jsonArg.message).toBe(jsonArg.errors[0]);
    });

    it("should not call next()", () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      const next = mockNext();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("with multiple validation errors", () => {
    it("should return all errors in the errors array", () => {
      const strictSchema = z.object({
        name: z.string().min(1, "Name is required"),
        email: z.string().email("Invalid email"),
      });
      const mw = zodValidate(strictSchema);
      const req = mockReq({ body: {} });
      const res = mockRes();
      const next = mockNext();

      mw(req, res, next);

      const jsonArg = res.json.mock.calls[0][0];
      expect(jsonArg.errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});
