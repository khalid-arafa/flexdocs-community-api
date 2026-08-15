// Credentialed-wildcard regression.
//
// `origin: true` reflects whatever Origin the browser sent. Paired with
// `credentials: true` that is the combination CORS exists to prevent: any site
// could call this API with the victim's cookies and read the response. A
// wildcard configuration ("*", or an unconfigured non-production install) must
// therefore be served as a genuinely public API — `Access-Control-Allow-Origin: *`
// and NO `Access-Control-Allow-Credentials` — while credentials remain
// available only to explicitly listed origins.

jest.mock("../utils/logger", () => ({
  log: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
}));
jest.mock("../core/db_service", () => ({ getDocument: jest.fn() }));

const { dynamicCors, resolveCorsOptions } = require("../middleware/cors.middleware");
const { getDocument } = require("../core/db_service");

const ENV = { ...process.env };
afterEach(() => {
  // Assigning an undefined back would store the literal string "undefined".
  for (const key of ["NODE_ENV", "ALLOWED_ORIGINS"]) {
    if (ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ENV[key];
  }
});

// getProjectOrigins caches per project code for 5 minutes, so every test that
// configures a project must use its own code or it inherits the previous one's.
let projectCounter = 0;
function projectPath(allowedOrigins) {
  const code = `proj${++projectCounter}`;
  getDocument.mockResolvedValue(allowedOrigins ? { allowedOrigins } : {});
  return `/projects/${code}/db/posts`;
}

function req({ origin, path = "/system/login", method = "GET" }) {
  return { headers: origin ? { origin } : {}, path, method };
}

// Resolve the options the delegate hands back to the cors package.
function optionsFor(request) {
  return new Promise((resolve, reject) =>
    resolveCorsOptions(request, (err, opts) => (err ? reject(err) : resolve(opts))),
  );
}

// Run the real cors middleware so the assertions are about the headers a
// browser actually receives, not just our intent.
function headersFor(request) {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader: (key, value) => {
      headers[key.toLowerCase()] = value;
    },
    getHeader: (key) => headers[key.toLowerCase()],
    end: () => {},
  };
  return new Promise((resolve, reject) => {
    dynamicCors(request, res, (err) => (err ? reject(err) : resolve(headers)));
  });
}

describe("system routes: wildcard ALLOWED_ORIGINS", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.ALLOWED_ORIGINS = "*";
  });

  it("never pairs credentials with a reflected origin", async () => {
    const opts = await optionsFor(req({ origin: "https://evil.example" }));
    expect(opts.credentials).toBe(false);
    expect(opts.origin).toBe("*");
  });

  it("sends ACAO: * and no ACAC header", async () => {
    const headers = await headersFor(req({ origin: "https://evil.example" }));
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("system routes: explicit ALLOWED_ORIGINS", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.ALLOWED_ORIGINS = "https://admin.example.com";
  });

  it("keeps credentials for a listed origin (the dashboard uses cookies)", async () => {
    const headers = await headersFor(req({ origin: "https://admin.example.com" }));
    expect(headers["access-control-allow-origin"]).toBe("https://admin.example.com");
    expect(headers["access-control-allow-credentials"]).toBe("true");
  });

  it("denies an unlisted origin (no ACAO at all)", async () => {
    const headers = await headersFor(req({ origin: "https://evil.example" }));
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("prefers the credentialed answer when '*' and a real origin are both listed", async () => {
    process.env.ALLOWED_ORIGINS = "*,https://admin.example.com";
    const listed = await optionsFor(req({ origin: "https://admin.example.com" }));
    expect(listed).toMatchObject({ origin: true, credentials: true });

    const other = await optionsFor(req({ origin: "https://somewhere.example" }));
    expect(other).toMatchObject({ origin: "*", credentials: false });
  });
});

describe("project routes", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  it("serves a project whose allowedOrigins is ['*'] as a public API", async () => {
    const path = projectPath(["*"]);
    const headers = await headersFor(req({ origin: "https://evil.example", path }));
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("keeps credentials for an origin the project listed", async () => {
    const path = projectPath(["https://app.example.com"]);
    const headers = await headersFor(req({ origin: "https://app.example.com", path }));
    expect(headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(headers["access-control-allow-credentials"]).toBe("true");
  });

  it("denies an unlisted origin in production", async () => {
    const path = projectPath(["https://app.example.com"]);
    const opts = await optionsFor(req({ origin: "https://evil.example", path }));
    expect(opts.origin).toBe(false);
  });

  it("still allows an unconfigured project outside production, without credentials", async () => {
    process.env.NODE_ENV = "development";
    const path = projectPath([]);
    const opts = await optionsFor(req({ origin: "http://localhost:5173", path }));
    expect(opts).toMatchObject({ origin: "*", credentials: false });
  });
});

describe("non-browser requests", () => {
  it("are allowed and emit no ACAO, so credentials there grant nothing", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOWED_ORIGINS = "https://admin.example.com";
    const headers = await headersFor(req({ origin: undefined }));
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// Regression: the dashboard calls /projects/:code/... with its session cookie.
// A project listing "*" used to answer `Allow-Origin: *`, which the browser
// refuses alongside credentials — the storage and database panels then render
// as empty with "blocked by CORS policy". Production hit exactly this, and
// there is no allowed-origins field in the dashboard UI to fix it with.
describe("the operator's own origins on project routes", () => {
  const DASHBOARD = "https://admin.example.com";

  it("grants credentials even when the project lists only '*'", async () => {
    process.env.ALLOWED_ORIGINS = DASHBOARD;
    const opts = await optionsFor(
      req({ origin: DASHBOARD, path: projectPath(["*"]) }),
    );
    expect(opts.credentials).toBe(true);
    expect(opts.origin).not.toBe("*");
  });

  it("still serves an unlisted third-party origin as an anonymous public API", async () => {
    process.env.ALLOWED_ORIGINS = DASHBOARD;
    const opts = await optionsFor(
      req({ origin: "https://somewhere-else.example", path: projectPath(["*"]) }),
    );
    expect(opts.credentials).toBe(false);
    expect(opts.origin).toBe("*");
  });

  it("a literal '*' in ALLOWED_ORIGINS never grants credentials", async () => {
    process.env.ALLOWED_ORIGINS = "*";
    const opts = await optionsFor(
      req({ origin: "https://anything.example", path: projectPath(["*"]) }),
    );
    expect(opts.credentials).toBe(false);
  });

  it("does not rescue an origin the project denies outright", async () => {
    process.env.ALLOWED_ORIGINS = DASHBOARD;
    process.env.NODE_ENV = "production";
    const opts = await optionsFor(
      req({ origin: "https://evil.example", path: projectPath(["https://site.example"]) }),
    );
    expect(opts.origin).toBe(false);
  });
});
