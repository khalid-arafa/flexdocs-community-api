// Regression tests for the second hardening batch (B2–B5).

jest.mock("../utils/logger", () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));
// db_service / config_service pull in the Mongo client; stub it so these
// pure-logic tests never open a connection.
jest.mock("../core/client", () => ({
  getUserDB: jest.fn(async () => {
    throw new Error("getUserDB should not be called in these tests");
  }),
}));

describe("B2 — sanitizeWriteData (operator stripping in document data)", () => {
  const { sanitizeWriteData } = require("../core/db_service");

  it("drops stray MongoDB operators from document data", () => {
    const out = sanitizeWriteData({ name: "x", $set: { a: 1 }, $inc: { n: 2 } });
    expect(out).toEqual({ name: "x" });
  });

  it("preserves $oid / $date coercion markers", () => {
    const out = sanitizeWriteData({ ref: { $oid: "507f1f77bcf86cd799439011" }, at: { $date: 1 } });
    expect(out).toEqual({ ref: { $oid: "507f1f77bcf86cd799439011" }, at: { $date: 1 } });
  });

  it("keeps JS-exec operators in place so the query formatter still rejects them loudly", () => {
    // sanitizeWriteData intentionally leaves $where so formatQueryObj throws downstream.
    const out = sanitizeWriteData({ $where: "1==1", name: "x" });
    expect(out).toHaveProperty("$where");
  });

  it("recurses into nested objects and arrays", () => {
    const out = sanitizeWriteData({ list: [{ ok: 1, $push: 2 }], obj: { $unset: 1, keep: 3 } });
    expect(out).toEqual({ list: [{ ok: 1 }], obj: { keep: 3 } });
  });

  it("passes ObjectId instances through untouched (regression: file uploads)", () => {
    // createStorageFile writes { _id: { $oid: <ObjectId instance> } }. Walking the
    // instance with Object.entries flattened it to a raw buffer object, Mongo
    // rejected the $-prefixed _id, and uploads reported success with no record.
    const { ObjectId } = require("mongodb");
    const id = new ObjectId();
    const out = sanitizeWriteData({ _id: { $oid: id }, ref: id });
    expect(out._id.$oid).toBe(id);
    expect(out.ref).toBe(id);
    expect(ObjectId.isValid(out._id.$oid)).toBe(true);
  });

  it("passes Date instances through untouched", () => {
    const at = new Date("2026-07-06T00:00:00Z");
    const out = sanitizeWriteData({ accessedAt: at, nested: { at } });
    expect(out.accessedAt).toBe(at);
    expect(out.nested.at).toBe(at);
  });
});

describe("B5 — reserved-name guards on drop/rename primitives", () => {
  const { dropCollection, renameCollection } = require("../core/db_service");

  it("refuses to drop a reserved/system collection (without touching the DB)", async () => {
    const res = await dropCollection({ userId: "u", projectCode: "p", collectionName: "_users" });
    expect(res.success).toBe(false);
  });

  it("refuses to rename to/from a reserved collection", async () => {
    const a = await renameCollection({ userId: "u", projectCode: "p", oldName: "_files", newName: "x" });
    const b = await renameCollection({ userId: "u", projectCode: "p", oldName: "posts", newName: "_users" });
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);
  });
});

describe("B4 — authenticated at-rest secret encryption (AES-256-GCM)", () => {
  const OLD = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD, ENCRYPTION_KEY: "unit-test-encryption-key" };
  });
  afterEach(() => {
    process.env = OLD;
  });

  it("round-trips a secret", () => {
    const { encryptSecret, decryptSecret } = require("../utils/encryptions");
    const ct = encryptSecret("super-secret-smtp-pass");
    expect(ct.startsWith("gcm:")).toBe(true);
    expect(ct).not.toContain("super-secret");
    expect(decryptSecret(ct)).toBe("super-secret-smtp-pass");
  });

  it("rejects tampered ciphertext (integrity)", () => {
    const { encryptSecret, decryptSecret } = require("../utils/encryptions");
    const ct = encryptSecret("value");
    const tampered = ct.slice(0, -2) + (ct.endsWith("00") ? "11" : "00");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("still decrypts legacy AES-256-CBC values (migration path)", () => {
    const { encrypt, decryptSecret } = require("../utils/encryptions");
    const legacy = encrypt("legacy-value"); // CBC format, no gcm: prefix
    expect(decryptSecret(legacy)).toBe("legacy-value");
  });
});

describe("B3 — SMTP host SSRF guard", () => {
  const { assertSafeSmtpHost } = require("../core/config_service");

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.4",
    "192.168.1.10",
    "169.254.169.254", // cloud metadata
    "localhost",
    "db.localhost",
    "::1",
    // alternate IP encodings that previously bypassed the guard
    "2130706433", // decimal 127.0.0.1
    "0x7f000001", // hex 127.0.0.1
    "0177.0.0.1", // octal first octet
    "127.0.0.1.", // trailing dot
    "::ffff:127.0.0.1", // IPv4-mapped IPv6
    "[::1]", // bracketed IPv6
    "0xA9FEA9FE", // hex 169.254.169.254 (metadata)
  ])("blocks internal host %s", (host) => {
    expect(() => assertSafeSmtpHost(host)).toThrow();
  });

  it.each([
    "smtp.gmail.com",
    "smtp.zoho.com",
    "mail.example.com",
    "8.8.8.8",
    "2001:4860:4860::8888", // public IPv6 (Google DNS)
  ])("allows public host %s", (host) => {
    expect(() => assertSafeSmtpHost(host)).not.toThrow();
  });
});
