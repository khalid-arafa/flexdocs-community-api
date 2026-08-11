// Token type-confusion on the two GET verification routes.
//
// All three verification tokens — "email", "reset-password-link" and
// "reset-password-action" — are signed with the same secret and carry the same
// { type, projectCode, accountId } shape, so the ONLY thing separating them is
// the `type` claim. POST /reset-password checked it. The two GET handlers did
// not, and each was exploitable in its own way:
//
//   GET /verify              — a reset token could be replayed to mark an
//                              address verified without ever receiving mail there.
//   GET /reset-password      — worse: this handler renders the account's stored
//                              reset-password-ACTION token into the form action.
//                              An "email" verification token (sitting in the
//                              user's inbox since registration) could be replayed
//                              to READ that action token and complete a full
//                              password reset — anyone may trigger a reset for a
//                              known address, so the stored token is easy to
//                              arrange. That is account takeover from a
//                              verification link.
//
// Verification tokens live 10 minutes (constants.tokenExpiry.verification), so
// requiring an exact type match cannot strand any link that was already in
// flight at deploy time.

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));
jest.mock("../core/verification_service");
jest.mock("../core/db_service");

const request = require("supertest");
const express = require("express");
const { verifyVerificationToken } = require("../core/verification_service");
const { getDocument, updateDocument } = require("../core/db_service");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/", require("../routes/public.routes"));
  return a;
}

function tokenOfType(type) {
  verifyVerificationToken.mockReturnValue({
    success: true,
    data: { type, projectCode: "p", accountId: "a" },
  });
}

describe("GET /verify token type binding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDocument.mockResolvedValue({ code: "p", userId: "u" });
    updateDocument.mockResolvedValue({ modifiedCount: 1 });
  });

  it("accepts a token minted for email verification", async () => {
    tokenOfType("email");
    const res = await request(app()).get("/verify?token=T");
    expect(res.status).toBe(200);
    expect(updateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ updateData: { emailVerified: true } }),
    );
  });

  it("rejects a reset-password-link token replayed here", async () => {
    tokenOfType("reset-password-link");
    const res = await request(app()).get("/verify?token=T");
    expect(res.status).toBe(400);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("rejects a reset-password-action token replayed here", async () => {
    tokenOfType("reset-password-action");
    const res = await request(app()).get("/verify?token=T");
    expect(res.status).toBe(400);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it("rejects a token carrying no type claim at all", async () => {
    verifyVerificationToken.mockReturnValue({
      success: true,
      data: { projectCode: "p", accountId: "a" },
    });
    const res = await request(app()).get("/verify?token=T");
    expect(res.status).toBe(400);
    expect(updateDocument).not.toHaveBeenCalled();
  });
});

describe("GET /reset-password token type binding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // project lookup, then account lookup
    getDocument
      .mockResolvedValueOnce({ code: "p", userId: "u", name: "Proj" })
      .mockResolvedValueOnce({ resetPasswordToken: "THE_ACTION_TOKEN" });
  });

  // The takeover path, pinned.
  it("does not hand the stored action token to an email-verification token", async () => {
    tokenOfType("email");
    const res = await request(app()).get("/reset-password?token=T");
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("THE_ACTION_TOKEN");
  });

  it("rejects an action token used to render the page", async () => {
    tokenOfType("reset-password-action");
    const res = await request(app()).get("/reset-password?token=T");
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("THE_ACTION_TOKEN");
  });

  it("still renders for the link token the reset email actually contains", async () => {
    tokenOfType("reset-password-link");
    const res = await request(app()).get("/reset-password?token=T");
    expect(res.status).toBe(200);
  });
});
