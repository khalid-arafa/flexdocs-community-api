// #1 regression: socket project-token confusion. A token lacking a `code` claim
// (e.g. a user token) must NOT authenticate the socket against an arbitrary
// project via a match-all lookup.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service");
jest.mock("../utils/encryptions");

const { socketAuth } = require("../middleware/socket_auth.middleware");
const { verifyToken } = require("../utils/encryptions");
const { getDocument } = require("../core/db_service");

function socketWith(projectToken) {
  return { handshake: { auth: { projectToken } } };
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

  it("rejects an expired project token", async () => {
    verifyToken.mockReturnValue({ expired: true });
    const next = jest.fn();
    await socketAuth(socketWith("expired"), next);
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
