// #1 regression: socket project-token confusion. A token lacking a `code` claim
// (e.g. a user token) must NOT authenticate the socket against an arbitrary
// project via a match-all lookup.
//
// #2 regression: an expired project token used to be rejected outright here
// while REST kept accepting the very same credential (REST authenticates by
// stored hash and never decodes the JWT). That split broke realtime and file
// uploads only, with no error surfaced to the client. An expired token is now
// accepted iff it is still a registered credential on the project — see the
// hash tests below — and rejected in every other case.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");
jest.mock("../utils/encryptions");

const { socketAuth } = require("../middleware/socket_auth.middleware");
const { verifyToken, decodeExpiredToken } = require("../utils/encryptions");
const { getDocument } = require("../core/db_service");
// Not mocked — the real SHA-256 is what the middleware compares against, so the
// fixtures below hash their tokens the same way a stored credential would.
const { hashProjectToken } = require("../utils/helper");

function socketWith(projectToken) {
  return { handshake: { auth: { projectToken } } };
}

function projectWithCredential(token, overrides = {}) {
  return {
    code: "myproj",
    userId: "owner",
    isActive: true,
    credentials: [
      { name: "default", creds: { projectTokenHash: hashProjectToken(token) } },
    ],
    ...overrides,
  };
}

describe("socketAuth project-token binding", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects a token with no `code` claim (no project lookup)", async () => {
    verifyToken.mockReturnValue({ userId: "u1", project: "p1" }); // user token, no code
    const next = jest.fn();
    await socketAuth(socketWith("any-jwt"), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("accepts a valid project token (has `code`) and binds the project", async () => {
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue({ code: "myproj", userId: "owner", isActive: true });
    const socket = socketWith("proj-jwt");
    const next = jest.fn();
    await socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith(); // no error
    expect(socket.project.code).toBe("myproj");
    expect(getDocument).toHaveBeenCalled();
  });
});

describe("socketAuth expired project tokens", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyToken.mockReturnValue({ expired: true });
  });

  it("accepts one that still matches a stored credential hash", async () => {
    decodeExpiredToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("expired-but-registered"));
    const socket = socketWith("expired-but-registered");
    const next = jest.fn();
    await socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(socket.project.code).toBe("myproj");
  });

  it("rejects one whose hash is not on the project (revoked or rotated away)", async () => {
    decodeExpiredToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("some-other-token"));
    const next = jest.fn();
    await socketAuth(socketWith("expired-and-revoked"), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects one on a project with no stored hashes at all", async () => {
    decodeExpiredToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue({
      code: "myproj",
      userId: "owner",
      isActive: true,
      credentials: [{ name: "legacy", creds: {} }],
    });
    const next = jest.fn();
    await socketAuth(socketWith("expired"), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects one whose signature does not verify", async () => {
    decodeExpiredToken.mockReturnValue(null); // tampered, not merely stale
    const next = jest.fn();
    await socketAuth(socketWith("forged"), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("rejects one for `_system`, which has no stored hash to fall back on", async () => {
    decodeExpiredToken.mockReturnValue({ code: "_system" });
    const next = jest.fn();
    await socketAuth(socketWith("expired-system"), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(getDocument).not.toHaveBeenCalled();
  });
});
