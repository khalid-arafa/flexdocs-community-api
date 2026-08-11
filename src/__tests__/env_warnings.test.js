// Weak-secret and NODE_ENV checks WARN and never refuse to boot.
//
// The refusal is the tempting design and the wrong one here. A short JWT_SECRET
// is a real weakness, but a system that is already running has already accepted
// it — turning that into a failed start converts a latent risk into an immediate
// outage on the next deploy, and the remedy (rotating the secret) invalidates
// every token in circulation at once, including project tokens already compiled
// into deployed browser bundles that cannot re-login their way out. Rotation is
// a scheduled migration. The check's job is to make sure nobody forgets, not to
// pick the moment.

const { warnOnWeakSecrets } = require("../utils/validate_env");

describe("warnOnWeakSecrets", () => {
  const ENV = { ...process.env };
  let warn;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JWT_SECRET = "x".repeat(48);
    process.env.ENCRYPTION_KEY = "y".repeat(48);
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    warn.mockRestore();
    process.env = { ...ENV };
  });

  function messages() {
    return warn.mock.calls.map(([m]) => m).join("\n");
  }

  it("says nothing when everything is configured well", () => {
    warnOnWeakSecrets();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about a short JWT_SECRET", () => {
    process.env.JWT_SECRET = "short";
    warnOnWeakSecrets();
    expect(messages()).toMatch(/JWT_SECRET is 5 characters/);
  });

  it("warns about a short ENCRYPTION_KEY", () => {
    process.env.ENCRYPTION_KEY = "tiny";
    warnOnWeakSecrets();
    expect(messages()).toMatch(/ENCRYPTION_KEY is 4 characters/);
  });

  it("warns when the two secrets are the same value", () => {
    process.env.JWT_SECRET = "z".repeat(48);
    process.env.ENCRYPTION_KEY = "z".repeat(48);
    warnOnWeakSecrets();
    expect(messages()).toMatch(/identical/);
  });

  it("warns when NODE_ENV is not production, naming the CORS consequence", () => {
    process.env.NODE_ENV = "development";
    warnOnWeakSecrets();
    expect(messages()).toMatch(/NODE_ENV is "development"/);
    expect(messages()).toMatch(/any origin with credentials/);
  });

  it("warns when NODE_ENV is unset entirely", () => {
    delete process.env.NODE_ENV;
    warnOnWeakSecrets();
    expect(messages()).toMatch(/NODE_ENV is "unset"/);
  });

  // The whole point: it must never take the process down.
  it("never exits the process, however bad the configuration is", () => {
    const exit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit was called");
    });
    process.env.JWT_SECRET = "a";
    process.env.ENCRYPTION_KEY = "a";
    delete process.env.NODE_ENV;

    expect(() => warnOnWeakSecrets()).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
