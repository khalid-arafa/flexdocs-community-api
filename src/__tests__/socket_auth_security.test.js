// #1 regression: socket project-token confusion. A token lacking a `code` claim
// (e.g. a user token) must NOT authenticate the socket against an arbitrary
// project via a match-all lookup.
//
// #2 regression: an expired project token used to be rejected outright here
// while REST kept accepting the very same credential (REST authenticates by
// stored hash and never decodes the JWT). That split broke realtime and file
// uploads only, with no error surfaced to the client.
//
// #3 regression: the hash check then ran ONLY for expired tokens, so deleting
// a credential revoked it instantly on REST but not on sockets, where it kept
// working until the token happened to age out. Every project token is now
// checked against the credential list regardless of age — that list, not the
// clock, is what makes a project token valid.

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
    getDocument.mockResolvedValue(projectWithCredential("proj-jwt"));
    const socket = socketWith("proj-jwt");
    const next = jest.fn();
    await socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith(); // no error
    expect(socket.project.code).toBe("myproj");
    expect(getDocument).toHaveBeenCalled();
  });
});

// The credential list is the authority for a project token, on both
// transports. Age is irrelevant; presence on the project is everything.
describe("socketAuth credential check applies regardless of expiry", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rejects an UNEXPIRED token whose credential was deleted", async () => {
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    // Rotated: the project now carries a different credential.
    getDocument.mockResolvedValue(projectWithCredential("the-new-token"));
    const next = jest.fn();
    await socketAuth(socketWith("the-revoked-token"), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects an unexpired token on a project with no credentials at all", async () => {
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue({
      code: "myproj", userId: "owner", isActive: true, credentials: [],
    });
    const next = jest.fn();
    await socketAuth(socketWith("orphaned"), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("still accepts an unexpired token that IS registered", async () => {
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("registered"));
    const socket = socketWith("registered");
    const next = jest.fn();
    await socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(socket.project.code).toBe("myproj");
  });

  // Revocation must not depend on which transport the client happens to use.
  it("treats an expired-but-registered and an unexpired-but-registered token alike", async () => {
    getDocument.mockResolvedValue(projectWithCredential("same-token"));

    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    const freshNext = jest.fn();
    await socketAuth(socketWith("same-token"), freshNext);
    // Asserted before the reset below — clearAllMocks would wipe this spy's
    // own call history along with the middleware's.
    expect(freshNext).toHaveBeenCalledWith();

    jest.clearAllMocks();
    getDocument.mockResolvedValue(projectWithCredential("same-token"));
    verifyToken.mockReturnValue({ expired: true });
    decodeExpiredToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    const staleNext = jest.fn();
    await socketAuth(socketWith("same-token"), staleNext);

    expect(staleNext).toHaveBeenCalledWith();
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
