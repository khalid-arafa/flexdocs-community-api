const { ObjectId } = require("mongodb");
const { encodeCursor, decodeCursor, buildCursorSeek } = require("../utils/cursor");

describe("encodeCursor / decodeCursor", () => {
  it("round-trips an _id-only cursor", () => {
    const id = new ObjectId().toString();
    const token = encodeCursor({ _id: id }, "_id");
    expect(decodeCursor(token)).toEqual({ id });
  });

  it("round-trips a cursor with a non-_id sort field (string value)", () => {
    const id = new ObjectId().toString();
    const token = encodeCursor({ _id: id, name: "Ada" }, "name");
    expect(decodeCursor(token)).toEqual({ id, f: "name", v: "Ada" });
  });

  it("serializes a Date sort value as a $date marker", () => {
    const id = new ObjectId().toString();
    const date = new Date("2024-01-01T00:00:00.000Z");
    const token = encodeCursor({ _id: id, createdAt: date }, "createdAt");
    expect(decodeCursor(token)).toEqual({
      id,
      f: "createdAt",
      v: { $date: "2024-01-01T00:00:00.000Z" },
    });
  });

  it("serializes an ObjectId sort value as an $oid marker", () => {
    const id = new ObjectId().toString();
    const ownerId = new ObjectId();
    const token = encodeCursor({ _id: id, ownerId }, "ownerId");
    expect(decodeCursor(token)).toEqual({
      id,
      f: "ownerId",
      v: { $oid: ownerId.toString() },
    });
  });

  it("returns null for a document with no _id", () => {
    expect(encodeCursor({ name: "x" }, "name")).toBeNull();
    expect(encodeCursor(null, "name")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(decodeCursor("not-valid-base64url-json")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"id":"not-an-object-id"}').toString("base64url"))).toBeNull();
  });
});

describe("buildCursorSeek", () => {
  it("defaults to _id ascending when no sort or cursor is given", () => {
    const result = buildCursorSeek({ query: {}, sort: undefined, cursorStr: undefined });
    expect(result.sort).toEqual({ _id: 1 });
    expect(result.query).toEqual({});
  });

  it("appends _id as a tiebreaker to a custom sort field", () => {
    const result = buildCursorSeek({ query: {}, sort: { name: -1 }, cursorStr: undefined });
    expect(result.sort).toEqual({ name: -1, _id: -1 });
  });

  it("builds an _id $gt seek condition for the default sort", () => {
    const id = new ObjectId().toString();
    const cursorStr = encodeCursor({ _id: id }, "_id");
    const result = buildCursorSeek({ query: {}, sort: undefined, cursorStr });
    expect(result.query).toEqual({ _id: { $gt: { $oid: id } } });
  });

  it("builds an $or keyset condition for a non-_id ascending sort", () => {
    const id = new ObjectId().toString();
    const cursorStr = encodeCursor({ _id: id, name: "Ada" }, "name");
    const result = buildCursorSeek({ query: {}, sort: { name: 1 }, cursorStr });
    expect(result.query).toEqual({
      $or: [
        { name: { $gt: "Ada" } },
        { name: "Ada", _id: { $gt: { $oid: id } } },
      ],
    });
  });

  it("flips to $lt for a descending sort", () => {
    const id = new ObjectId().toString();
    const cursorStr = encodeCursor({ _id: id, name: "Ada" }, "name");
    const result = buildCursorSeek({ query: {}, sort: { name: -1 }, cursorStr });
    expect(result.query.$or[0]).toEqual({ name: { $lt: "Ada" } });
  });

  it("combines the seek condition with an existing query via $and", () => {
    const id = new ObjectId().toString();
    const cursorStr = encodeCursor({ _id: id }, "_id");
    const result = buildCursorSeek({ query: { isActive: true }, sort: undefined, cursorStr });
    expect(result.query).toEqual({
      $and: [{ isActive: true }, { _id: { $gt: { $oid: id } } }],
    });
  });

  it("flags an invalid cursor instead of throwing", () => {
    const result = buildCursorSeek({ query: {}, sort: undefined, cursorStr: "garbage" });
    expect(result.invalidCursor).toBe(true);
  });
});
