// #1 regression: socket project-token confusion. A token lacking a `code` claim
// (e.g. a user token) must NOT authenticate the socket against an arbitrary
// project via a match-all lookup.
//
// #2 regression: an expired project token used to be rejected outright here
// while REST kept accepting the very same credential (REST authenticates by
// stored hash and never decodes the JWT). That split broke realtime and file
// uploads only, with no error surfaced to the client.
//
// #3: the hash check runs for every token and a failure is now fatal for
// unexpired tokens too, matching REST (which re-hashes on every request). It
// was warn-only for a while because enforcing it took production uploads down —
// a live site was running on a token absent from its project's credential list
// and had been fine for as long as it stayed unexpired — so the old
// warn-and-allow behaviour survives as an opt-OUT,
// ENFORCE_SOCKET_PROJECT_CREDENTIAL=false. Both paths log the presented hash.

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

// An unexpired token that is not in the credential list is refused by default
// and only allowed under the explicit opt-out — see the header note.
describe("socketAuth credential check on unexpired tokens", () => {
  const Logger = require("../utils/logger");
  const ENV = process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL;

  beforeEach(() => {
    jest.clearAllMocks();
    // The default under test is "flag absent", so don't inherit the operator's
    // shell value.
    delete process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL;
  });
  afterEach(() => {
    if (ENV === undefined) delete process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL;
    else process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL = ENV;
  });

  // The production regression, pinned: rejecting this exact case took uploads
  // down with nothing visible to the client, so the default stays permissive
  // and the warning is what an operator acts on.
  it("ALLOWS an unexpired token whose credential is missing, by default", async () => {
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("the-registered-token"));
    const socket = socketWith("not-registered");
    const next = jest.fn();
    await socketAuth(socket, next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(socket.project.code).toBe("myproj");
  });

  // The rejection is invisible to the client (socket.io buffers the emit), so
  // the log is the only diagnosis an operator gets. It must name the project
  // and the hash presented.
  it("logs a diagnosable warning naming the project and presented hash", async () => {
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("the-registered-token"));
    await socketAuth(socketWith("not-registered"), jest.fn());

    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a registered credential"),
      expect.objectContaining({ project: "myproj", presentedHash: expect.any(String) }),
    );
    const [message] = Logger.warn.mock.calls[0];
    expect(message).toContain("ENFORCE_SOCKET_PROJECT_CREDENTIAL=true");
  });

  // Enforcement is opt-IN: an operator who has reconciled the credential list
  // turns it on, and only then does the same handshake fail.
  it("REJECTS it once an operator opts in with =true", async () => {
    process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL = "true";
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("the-registered-token"));
    const socket = socketWith("not-registered");
    const next = jest.fn();
    await socketAuth(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(socket.project).toBeUndefined();
    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Socket rejected"),
      expect.objectContaining({ project: "myproj", presentedHash: expect.any(String) }),
    );
  });

  // Only the exact string enforces. Guessing wrong here costs a silent
  // outage, so anything ambiguous — a typo, a blank, a truthy-looking value —
  // must fall back to allowing.
  it.each(["false", "TRUE", "", "0", "no", "False", "1", "yes"])(
    "keeps allowing when the flag is %p (only \"true\" enforces)",
    async (value) => {
      process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL = value;
      verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
      getDocument.mockResolvedValue(projectWithCredential("registered"));
      const next = jest.fn();
      await socketAuth(socketWith("not-registered"), next);
      expect(next).toHaveBeenCalledWith(); // no error
    },
  );

  // The log has to name the hash actually presented, or it cannot be matched
  // against the credential list to find the mismatch. True on both paths.
  it.each([
    ["allowing by default", undefined],
    ["rejecting under the opt-in", "true"],
  ])("logs the presented hash alongside the stored ones when %s", async (_label, flag) => {
    if (flag === undefined) delete process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL;
    else process.env.ENFORCE_SOCKET_PROJECT_CREDENTIAL = flag;
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("the-registered-token"));
    await socketAuth(socketWith("not-registered"), jest.fn());

    const [, meta] = Logger.warn.mock.calls[0];
    expect(meta.presentedHash).toBe(hashProjectToken("not-registered"));
    expect(meta.storedHashes).toEqual([hashProjectToken("the-registered-token")]);
  });

  // `_system` is synthesised, not read from Mongo, so it has no credential
  // list to match — enforcement must not lock it out. (Its expiry check, which
  // IS its revocation signal, is covered further down.)
  it("exempts an unexpired `_system` token from the credential check", async () => {
    verifyToken.mockReturnValue({ code: "_system" });
    const socket = socketWith("system-token");
    const next = jest.fn();
    await socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(socket.project.code).toBe("_system");
  });

  it("allows an unexpired token on a project with no credentials at all", async () => {
    verifyToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue({
      code: "myproj", userId: "owner", isActive: true, credentials: [],
    });
    const next = jest.fn();
    await socketAuth(socketWith("orphaned"), next);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  // Unchanged and still enforced: an expired token has nothing else vouching
  // for it, so a missing credential stays fatal.
  it("still rejects an EXPIRED token whose credential is missing", async () => {
    verifyToken.mockReturnValue({ expired: true });
    decodeExpiredToken.mockReturnValue({ projectId: "id", name: "n", code: "myproj" });
    getDocument.mockResolvedValue(projectWithCredential("some-other-token"));
    const next = jest.fn();
    await socketAuth(socketWith("expired-and-unregistered"), next);
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
