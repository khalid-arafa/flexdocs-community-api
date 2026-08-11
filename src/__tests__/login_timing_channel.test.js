// Login answered "Invalid email or password" for both an unknown address and a
// wrong password, but only PAID for bcrypt in the second case: an unknown
// address returned in milliseconds while a real one cost ~250ms at 12 rounds.
// That difference is measurable over a network and re-opens the account
// enumeration the shared message exists to close.
//
// Asserted by CODE PATH, not by wall-clock: a timing assertion on a busy CI box
// is exactly the kind of test that fails for unrelated reasons and gets deleted.
// What we pin is that the not-found branch performs a bcrypt comparison at all.

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));
jest.mock("../core/db_service");
jest.mock("../core/client");
jest.mock("../utils/encryptions");

const { getDocument, updateDocument } = require("../core/db_service");
const {
  verifyPassword,
  burnPasswordComparison,
  getToken,
} = require("../utils/encryptions");
const { loginWithEmailAndPassword } = require("../core/auth_service");

describe("login does not leak account existence through timing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getToken.mockReturnValue("jwt");
    // The failed-login path fires lockout bookkeeping without awaiting it and
    // attaches .catch, so this must be a promise or the mock throws instead of
    // the real error.
    updateDocument.mockResolvedValue({ modifiedCount: 1 });
  });

  it("spends a bcrypt comparison even when the email is unknown", async () => {
    getDocument.mockResolvedValue(null);

    await expect(
      loginWithEmailAndPassword({
        userId: "u",
        projectCode: "p",
        email: "nobody@example.com",
        password: "hunter2",
      }),
    ).rejects.toThrow("Invalid email or password");

    expect(burnPasswordComparison).toHaveBeenCalledWith("hunter2");
  });

  it("gives the same message for a wrong password on a real account", async () => {
    getDocument.mockResolvedValue({
      _id: "a1",
      email: "real@example.com",
      password: "$2b$12$stored",
      isActive: true,
    });
    verifyPassword.mockResolvedValue({ match: false, needsRehash: false });

    await expect(
      loginWithEmailAndPassword({
        userId: "u",
        projectCode: "p",
        email: "real@example.com",
        password: "wrong",
      }),
    ).rejects.toThrow("Invalid email or password");
  });

  it("does not burn a second comparison when a real bcrypt check already ran", async () => {
    getDocument.mockResolvedValue({
      _id: "a1",
      email: "real@example.com",
      password: "$2b$12$stored",
      isActive: true,
    });
    verifyPassword.mockResolvedValue({ match: false, needsRehash: false });

    await expect(
      loginWithEmailAndPassword({
        userId: "u",
        projectCode: "p",
        email: "real@example.com",
        password: "wrong",
      }),
    ).rejects.toThrow();

    expect(verifyPassword).toHaveBeenCalled();
    expect(burnPasswordComparison).not.toHaveBeenCalled();
  });
});

describe("burnPasswordComparison itself", () => {
  const realEncryptions = jest.requireActual("../utils/encryptions");

  it("resolves without throwing and reports no result to the caller", async () => {
    await expect(
      realEncryptions.burnPasswordComparison("anything"),
    ).resolves.toBeUndefined();
  });

  it("tolerates a null password without throwing", async () => {
    await expect(
      realEncryptions.burnPasswordComparison(null),
    ).resolves.toBeUndefined();
  });
});
