// C4 regression: POST /reset-password must reject type-confused tokens and
// enforce single-use by matching the account's stored reset token.

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));
jest.mock("../core/verification_service");
jest.mock("../core/db_service");
jest.mock("../utils/encryptions");
jest.mock("../utils/validators");

const request = require("supertest");
const express = require("express");
const { verifyVerificationToken } = require("../core/verification_service");
const { getDocument, updateDocument } = require("../core/db_service");
const { hashPassword } = require("../utils/encryptions");
const { isStrongPassword } = require("../utils/validators");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/", require("../routes/public.routes"));
  return a;
}

// project lookup is the 1st getDocument call, account lookup the 2nd.
function mockLookups(storedToken) {
  getDocument.mockReset();
  getDocument
    .mockResolvedValueOnce({ code: "p", userId: "u" })
    .mockResolvedValueOnce({ resetPasswordToken: storedToken });
}

describe("POST /reset-password hardening", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isStrongPassword.mockReturnValue(true);
    hashPassword.mockResolvedValue("$2b$12$hash");
    updateDocument.mockResolvedValue({ modifiedCount: 1 });
    mockLookups("ACTION_TOKEN");
  });

  it("rejects a non-reset (type-confused) token", async () => {
    verifyVerificationToken.mockReturnValue({
      success: true,
      data: { type: "email", projectCode: "p", accountId: "a" },
    });
    const res = await request(app())
      .post("/reset-password?token=ACTION_TOKEN")
      .send({ newPassword: "Aa1!aaaa" });
    expect(res.status).toBe(400);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("rejects when presented token != the account's stored token (single-use)", async () => {
    verifyVerificationToken.mockReturnValue({
      success: true,
      data: { type: "reset-password-action", projectCode: "p", accountId: "a" },
    });
    mockLookups("OTHER_TOKEN"); // account holds a different/rotated token
    const res = await request(app())
      .post("/reset-password?token=ACTION_TOKEN")
      .send({ newPassword: "Aa1!aaaa" });
    expect(res.status).toBe(400);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("rejects when the stored token was already cleared (used)", async () => {
    verifyVerificationToken.mockReturnValue({
      success: true,
      data: { type: "reset-password-action", projectCode: "p", accountId: "a" },
    });
    mockLookups(null);
    const res = await request(app())
      .post("/reset-password?token=ACTION_TOKEN")
      .send({ newPassword: "Aa1!aaaa" });
    expect(res.status).toBe(400);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("accepts a valid reset-action token matching the stored token", async () => {
    verifyVerificationToken.mockReturnValue({
      success: true,
      data: { type: "reset-password-action", projectCode: "p", accountId: "a" },
    });
    const res = await request(app())
      .post("/reset-password?token=ACTION_TOKEN")
      .send({ newPassword: "Aa1!aaaa" });
    expect(res.status).toBe(200);
    expect(updateDocument).toHaveBeenCalled();
  });
});
