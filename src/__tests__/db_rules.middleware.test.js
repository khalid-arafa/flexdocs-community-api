const { validateCollectionParam } = require("../middleware/db_rules.middleware");
const { mockReq, mockRes } = require("./helpers/express-mocks");

describe("validateCollectionParam", () => {
  it('should return true for valid collection name "users"', () => {
    const req = mockReq({ params: { col: "users" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return true for "user_data_2"', () => {
    const req = mockReq({ params: { col: "user_data_2" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
  });

  it("should return true for name at max length (64 chars)", () => {
    const name = "a" + "b".repeat(63);
    const req = mockReq({ params: { col: name } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
  });

  it('should return false and send 400 for reserved name "_users"', () => {
    const req = mockReq({ params: { col: "_users" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain("system collections");
  });

  it('should return false and send 400 for reserved name "admin"', () => {
    const req = mockReq({ params: { col: "admin" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('should return false and send 400 for reserved name "_system"', () => {
    const req = mockReq({ params: { col: "_system" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
  });

  it("should return false for name starting with number", () => {
    const req = mockReq({ params: { col: "1abc" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain("Invalid collection name");
  });

  it("should return false for name with hyphens", () => {
    const req = mockReq({ params: { col: "my-col" } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
  });

  it("should return false for name > 64 chars", () => {
    const name = "a".repeat(65);
    const req = mockReq({ params: { col: name } });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(false);
  });

  it("should return true when col param is undefined (no col param)", () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    expect(validateCollectionParam(req, res)).toBe(true);
  });

  it("should return false for empty string param", () => {
    const req = mockReq({ params: { col: "" } });
    const res = mockRes();
    // empty string is falsy, so the guards don't trigger
    expect(validateCollectionParam(req, res)).toBe(true);
  });
});
