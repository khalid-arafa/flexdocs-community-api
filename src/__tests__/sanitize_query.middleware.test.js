const {
  sanitizeQuery,
  sanitizeObject,
  UnsafeQueryError,
  MAX_REGEX_LENGTH,
  MAX_QUERY_DEPTH,
} = require("../middleware/sanitize_query.middleware");

function runMiddleware(body) {
  const req = { body };
  const res = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  let nexted = false;
  sanitizeQuery(req, res, () => {
    nexted = true;
  });
  return { req, res, nexted };
}

describe("operator allowlist", () => {
  it("keeps allowed operators", () => {
    const out = sanitizeObject({ age: { $gt: 18, $lte: 65 }, tags: { $in: ["a"] } });
    expect(out).toEqual({ age: { $gt: 18, $lte: 65 }, tags: { $in: ["a"] } });
  });

  it("strips code-execution operators", () => {
    const out = sanitizeObject({ $where: "1==1", $function: {}, $accumulator: {}, ok: 1 });
    expect(out).toEqual({ ok: 1 });
  });

  it("strips nested disallowed operators", () => {
    const out = sanitizeObject({ $and: [{ $where: "x" }, { a: 1 }] });
    expect(out).toEqual({ $and: [{}, { a: 1 }] });
  });

  it("leaves non-object values untouched", () => {
    expect(sanitizeObject("str")).toBe("str");
    expect(sanitizeObject(5)).toBe(5);
    expect(sanitizeObject(null)).toBeNull();
  });
});

describe("$regex bounds", () => {
  it("allows an ordinary pattern", () => {
    expect(sanitizeObject({ name: { $regex: "^ali", $options: "i" } })).toEqual({
      name: { $regex: "^ali", $options: "i" },
    });
  });

  it("rejects an over-long pattern", () => {
    const long = "a".repeat(MAX_REGEX_LENGTH + 1);
    expect(() => sanitizeObject({ n: { $regex: long } })).toThrow(UnsafeQueryError);
  });

  it("allows a pattern exactly at the limit", () => {
    const atLimit = "a".repeat(MAX_REGEX_LENGTH);
    expect(() => sanitizeObject({ n: { $regex: atLimit } })).not.toThrow();
  });

  // Classic catastrophic-backtracking shapes.
  it.each(["(a+)+$", "(a*)*$", "(a|aa)+$", "([a-z]+)*$"])(
    "rejects nested quantifier %s",
    (pattern) => {
      expect(() => sanitizeObject({ n: { $regex: pattern } })).toThrow(UnsafeQueryError);
    },
  );

  it("rejects a non-string pattern", () => {
    expect(() => sanitizeObject({ n: { $regex: { evil: true } } })).toThrow(UnsafeQueryError);
  });

  it("checks regexes nested inside logical operators", () => {
    expect(() =>
      sanitizeObject({ $or: [{ a: 1 }, { b: { $regex: "(x+)+" } }] }),
    ).toThrow(UnsafeQueryError);
  });
});

describe("nesting depth", () => {
  it("allows a reasonably nested query", () => {
    let q = { a: 1 };
    for (let i = 0; i < 4; i++) q = { $and: [q] };
    expect(() => sanitizeObject(q)).not.toThrow();
  });

  it("rejects a query nested past the cap", () => {
    let q = { a: 1 };
    for (let i = 0; i < MAX_QUERY_DEPTH + 5; i++) q = { $and: [q] };
    expect(() => sanitizeObject(q)).toThrow(UnsafeQueryError);
  });
});

describe("middleware behaviour", () => {
  it("sanitizes each guarded body field and continues", () => {
    const { req, nexted } = runMiddleware({
      query: { $where: "x", a: 1 },
      filter: { $function: {}, b: 2 },
      sort: { createdAt: -1 },
      where: { c: 3 },
    });
    expect(nexted).toBe(true);
    expect(req.body.query).toEqual({ a: 1 });
    expect(req.body.filter).toEqual({ b: 2 });
    expect(req.body.sort).toEqual({ createdAt: -1 });
  });

  it("answers 400 instead of running an unsafe regex", () => {
    const { res, nexted } = runMiddleware({ query: { n: { $regex: "(a+)+" } } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(res.payload.message).toMatch(/catastrophic backtracking/i);
  });

  it("answers 400 for an over-deep query", () => {
    let q = { a: 1 };
    for (let i = 0; i < MAX_QUERY_DEPTH + 5; i++) q = { $and: [q] };
    const { res } = runMiddleware({ query: q });
    expect(res.statusCode).toBe(400);
  });

  it("passes through a body with no guarded fields", () => {
    const { nexted } = runMiddleware({ name: "x" });
    expect(nexted).toBe(true);
  });

  it("tolerates a missing body", () => {
    const { nexted } = runMiddleware(undefined);
    expect(nexted).toBe(true);
  });
});
