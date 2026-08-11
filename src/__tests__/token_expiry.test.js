/**
 * N6 / B9 — per-project auth token lifetime.
 *
 * FlexDocs JWTs are stateless and were minted with a flat 30-day expiry, so a
 * stolen token was good for a month. Shortening that is only safe for projects
 * whose clients can refresh, hence a per-project setting rather than a global
 * change.
 *
 * Two properties matter more than the parsing details:
 *   - a project that never sets it is byte-identical to the old behaviour;
 *   - a value that is somehow unreadable falls back to the default rather than
 *     failing to mint, because refusing to issue a token locks every user of
 *     that project out.
 */

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));

const {
  authTokenExpiryFor,
  isValidAuthTokenExpiry,
  durationMinutes,
} = require("../utils/token_expiry");
const { tokenExpiry } = require("../constants");
const Logger = require("../utils/logger");

beforeEach(() => jest.clearAllMocks());

describe("durationMinutes", () => {
  it.each([
    ["5m", 5],
    ["90m", 90],
    ["12h", 720],
    ["1d", 1440],
    ["7d", 10080],
    ["30d", 43200],
  ])("parses %s", (value, expected) => {
    expect(durationMinutes(value)).toBe(expected);
  });

  it("tolerates surrounding whitespace", () => {
    expect(durationMinutes("  7d  ")).toBe(10080);
  });

  it.each([
    ["30days", "unit spelled out"],
    ["7", "no unit"],
    ["d7", "reversed"],
    ["", "empty"],
    ["7.5d", "fractional"],
    ["-7d", "negative"],
    ["1w", "unsupported unit"],
    ["30s", "seconds are deliberately rejected — far likelier a typo for 30d"],
  ])("rejects %s (%s)", (value) => {
    expect(durationMinutes(value)).toBeNull();
  });

  it.each([null, undefined, 7, {}, []])("rejects the non-string %p", (value) => {
    expect(durationMinutes(value)).toBeNull();
  });

  describe("bounds", () => {
    it("rejects anything under 5 minutes", () => {
      expect(durationMinutes("4m")).toBeNull();
      expect(durationMinutes("5m")).toBe(5);
    });

    it("rejects anything over 30 days, so a typo cannot outlive the default", () => {
      expect(durationMinutes("31d")).toBeNull();
      expect(durationMinutes("30d")).toBe(43200);
      expect(durationMinutes("721h")).toBeNull();
    });
  });
});

describe("isValidAuthTokenExpiry", () => {
  it("accepts the intended ladder rungs", () => {
    for (const rung of ["30d", "7d", "1d"]) {
      expect(isValidAuthTokenExpiry(rung)).toBe(true);
    }
  });

  it("rejects a plausible-looking typo", () => {
    expect(isValidAuthTokenExpiry("7days")).toBe(false);
  });
});

describe("authTokenExpiryFor", () => {
  it("returns the 30-day default for a project that never set it", () => {
    expect(authTokenExpiryFor({ code: "p" })).toBe(tokenExpiry.auth);
    expect(tokenExpiry.auth).toBe("30d");
  });

  it.each([undefined, null, ""])("treats %p as unset", (value) => {
    expect(authTokenExpiryFor({ code: "p", authTokenExpiry: value })).toBe(
      tokenExpiry.auth,
    );
  });

  it("returns a configured value", () => {
    expect(authTokenExpiryFor({ code: "p", authTokenExpiry: "1d" })).toBe("1d");
  });

  // Refusing to mint would lock every user of the project out — strictly worse
  // than an expiry that is longer than the operator intended.
  it("falls back to the default for an unreadable stored value, and says so", () => {
    expect(authTokenExpiryFor({ code: "p", authTokenExpiry: "7days" })).toBe(
      tokenExpiry.auth,
    );
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining("authTokenExpiry"));
  });

  it("never throws on a missing project", () => {
    expect(authTokenExpiryFor(undefined)).toBe(tokenExpiry.auth);
    expect(authTokenExpiryFor(null)).toBe(tokenExpiry.auth);
  });

  it("does not warn for the ordinary unset case", () => {
    authTokenExpiryFor({ code: "p" });
    expect(Logger.warn).not.toHaveBeenCalled();
  });
});
