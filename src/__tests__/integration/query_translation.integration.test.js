/**
 * formatQueryObj + $oid/$date coercion, executed against a REAL query planner.
 *
 * Everything here goes through the genuine src/core/db_service. The unit suite
 * only ever asserted the SHAPE formatQueryObj returns; these tests assert the
 * DOCUMENTS MongoDB actually hands back, which is the only way to catch a
 * translation that is well-formed but semantically wrong.
 */

const { ObjectId } = require("mongodb");
const {
  describeIntegration,
  projectCodeFor,
  TEST_USER_ID,
  rawDb,
  resetDb,
  closeConnections,
} = require("./helpers/db");

const PROJECT = projectCodeFor("query_translation");
const COL = "widgets";

describeIntegration("integration: query translation against real MongoDB", () => {
  let dbService;
  let db;

  // Fixed ids so assertions can name exact documents.
  const idA = new ObjectId();
  const idB = new ObjectId();
  const idC = new ObjectId();

  const DATE_A = new Date("2020-01-01T00:00:00.000Z");
  const DATE_B = new Date("2022-06-15T12:30:00.000Z");
  const DATE_C = new Date("2024-12-31T23:59:59.000Z");

  const ownerX = new ObjectId();
  const ownerY = new ObjectId();

  const call = (fn, extra) =>
    dbService[fn]({
      userId: TEST_USER_ID,
      projectCode: PROJECT,
      collectionName: COL,
      ...extra,
    });

  const names = (docs) => docs.map((d) => d.name).sort();

  beforeAll(async () => {
    await resetDb(PROJECT);
    dbService = require("../../core/db_service");
    db = await rawDb(PROJECT);

    // Seeded with the RAW driver so the fixtures have genuine BSON types —
    // real ObjectIds and real Dates — independent of anything under test.
    await db.collection(COL).insertMany([
      {
        _id: idA,
        name: "alpha",
        owner: ownerX,
        qty: 5,
        tags: ["red", "small"],
        when: DATE_A,
        nested: { level: 1 },
      },
      {
        _id: idB,
        name: "beta",
        owner: ownerY,
        qty: 15,
        tags: ["blue", "small", "round"],
        when: DATE_B,
        nested: { level: 2 },
      },
      {
        _id: idC,
        name: "gamma",
        owner: ownerX,
        qty: 30,
        tags: ["red", "large"],
        when: DATE_C,
        // `nested` deliberately absent — exercises $exists.
      },
    ]);
  });

  afterAll(async () => {
    await resetDb(PROJECT);
    await closeConnections();
  });

  // -------------------------------------------------------------------------
  // _id coercion
  // -------------------------------------------------------------------------
  describe("_id coercion", () => {
    test("a bare hex string as the sole key finds the document", async () => {
      const doc = await call("getDocument", { query: { _id: idB.toString() } });
      expect(doc).not.toBeNull();
      expect(doc.name).toBe("beta");
    });

    test("a hex string _id alongside another key still finds the document", async () => {
      // The sole-key shortcut cannot fire here, so this exercises coerceIdField.
      const doc = await call("getDocument", {
        query: { _id: idB.toString(), name: "beta" },
      });
      expect(doc).not.toBeNull();
      expect(doc._id).toEqual(idB);
    });

    test("a non-matching second key correctly yields nothing", async () => {
      const doc = await call("getDocument", {
        query: { _id: idB.toString(), name: "alpha" },
      });
      expect(doc).toBeNull();
    });

    test("_id: {$in: [...]} coerces every array element", async () => {
      const docs = await call("getManyDocuments", {
        query: { _id: { $in: [idA.toString(), idC.toString()] } },
      });
      expect(names(docs)).toEqual(["alpha", "gamma"]);
    });

    test("_id: {$nin: [...]} coerces every array element", async () => {
      const docs = await call("getManyDocuments", {
        query: { _id: { $nin: [idA.toString(), idC.toString()] } },
      });
      expect(names(docs)).toEqual(["beta"]);
    });

    test("_id wrapped in an explicit {$oid} marker finds the document", async () => {
      const docs = await call("getManyDocuments", {
        query: { _id: { $oid: idC.toString() } },
      });
      expect(names(docs)).toEqual(["gamma"]);
    });

    test("_id range operators work when the value carries an explicit {$oid}", async () => {
      const docs = await call("getManyDocuments", {
        query: { _id: { $gt: { $oid: idA.toString() } } },
        sort: { _id: 1 },
      });
      // ObjectIds here were generated in ascending order, so B and C follow A.
      expect(names(docs)).toEqual(["beta", "gamma"]);
    });

    /**
     * KNOWN BUG #5 — `_id` coercion covers equality, $in and $nin but NOT the
     * range operators. db_service.js coerceIdField() only reaches into $in/$nin
     * arrays (db_service.js:75-80); anything else under `_id` is handed to
     * processObject(), which has no idea it is beneath an `_id` key, so the hex
     * string survives as a String.
     *
     * MongoDB then applies type bracketing: a range predicate only matches
     * values of the same BSON type, so comparing String against stored
     * ObjectIds matches NOTHING. The caller gets a silent empty page rather
     * than an error — the same failure mode the sole-key/multi-key `_id` fixes
     * in this file's comments were written to eliminate, still present for
     * ranges.
     *
     * Not reachable from the cursor pagination path, which deliberately emits
     * the {$oid} marker (utils/cursor.js buildCursorSeek) and is covered above.
     */
    test("KNOWN BUG: an _id range against a bare hex string silently matches nothing", async () => {
      const docs = await call("getManyDocuments", {
        query: { _id: { $gt: idA.toString() } },
        sort: { _id: 1 },
      });
      expect(docs).toEqual([]); // should have returned beta and gamma

      // Same predicate, same data, marker supplied — proof the data is there
      // and only the missing coercion is responsible.
      const withMarker = await call("getManyDocuments", {
        query: { _id: { $gt: { $oid: idA.toString() } } },
        sort: { _id: 1 },
      });
      expect(names(withMarker)).toEqual(["beta", "gamma"]);
    });
  });

  // -------------------------------------------------------------------------
  // Caller-supplied _id — a production consumer depends on choosing its own ids
  // -------------------------------------------------------------------------
  describe("caller-supplied _id via the $oid marker", () => {
    const CHOSEN = "0123456789abcdef01234567";

    test("createDocument honors an _id supplied as {$oid} and stores a real ObjectId", async () => {
      const insertedId = await call("createDocument", {
        data: { _id: { $oid: CHOSEN }, name: "caller-chosen" },
      });

      expect(insertedId).not.toBeNull();
      expect(insertedId.toString()).toBe(CHOSEN);

      // Verified with the raw driver: the id must be a genuine ObjectId in the
      // stored document, not a nested {$oid} sub-document or a string.
      const stored = await db.collection(COL).findOne({ _id: new ObjectId(CHOSEN) });
      expect(stored).not.toBeNull();
      expect(stored._id).toBeInstanceOf(ObjectId);
      expect(stored.name).toBe("caller-chosen");
    });

    test("the chosen id round-trips: it can be read back by that same hex string", async () => {
      const doc = await call("getDocument", { query: { _id: CHOSEN } });
      expect(doc).not.toBeNull();
      expect(doc.name).toBe("caller-chosen");
    });

    test("reusing a chosen id is rejected by the real unique _id index", async () => {
      // createDocument deliberately does not swallow write errors, so the
      // duplicate-key failure from the real _id index reaches the caller.
      await expect(
        call("createDocument", { data: { _id: { $oid: CHOSEN }, name: "duplicate" } }),
      ).rejects.toMatchObject({ code: 11000 });

      expect(await db.collection(COL).countDocuments({ _id: new ObjectId(CHOSEN) })).toBe(1);
    });

    test("a caller-chosen id is usable for update and delete", async () => {
      await call("updateDocument", {
        query: { _id: CHOSEN },
        updateData: { name: "caller-chosen-renamed" },
      });
      expect((await db.collection(COL).findOne({ _id: new ObjectId(CHOSEN) })).name).toBe(
        "caller-chosen-renamed",
      );

      await call("deleteDocument", { query: { _id: CHOSEN } });
      expect(await db.collection(COL).countDocuments({ _id: new ObjectId(CHOSEN) })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // $oid / $date markers on ordinary fields
  // -------------------------------------------------------------------------
  describe("coercion markers on non-_id fields", () => {
    test("{$oid} matches a stored ObjectId in an ordinary field", async () => {
      const docs = await call("getManyDocuments", {
        query: { owner: { $oid: ownerX.toString() } },
      });
      expect(names(docs)).toEqual(["alpha", "gamma"]);
    });

    test("a plain hex string does NOT match a stored ObjectId — the marker is required", async () => {
      // Coercion outside `_id` is opt-in; without {$oid} the value stays a
      // string and BSON never compares a String equal to an ObjectId.
      const docs = await call("getManyDocuments", { query: { owner: ownerX.toString() } });
      expect(docs).toEqual([]);
    });

    test("{$oid} inside $in coerces each element", async () => {
      const docs = await call("getManyDocuments", {
        query: { owner: { $in: [{ $oid: ownerY.toString() }] } },
      });
      expect(names(docs)).toEqual(["beta"]);
    });

    test("{$date} produces a real Date so range filters compare chronologically", async () => {
      const docs = await call("getManyDocuments", {
        query: { when: { $gte: { $date: "2021-01-01T00:00:00.000Z" } } },
      });
      expect(names(docs)).toEqual(["beta", "gamma"]);
    });

    test("{$date} bounded on both sides selects the middle document", async () => {
      const docs = await call("getManyDocuments", {
        query: {
          when: {
            $gt: { $date: "2021-01-01T00:00:00.000Z" },
            $lt: { $date: "2023-01-01T00:00:00.000Z" },
          },
        },
      });
      expect(names(docs)).toEqual(["beta"]);
    });

    test("an ISO string without the {$date} marker matches nothing against stored Dates", async () => {
      const docs = await call("getManyDocuments", {
        query: { when: { $gte: "2021-01-01T00:00:00.000Z" } },
      });
      expect(docs).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Operator allowlist — real result sets, not shapes
  // -------------------------------------------------------------------------
  describe("supported operators return the correct documents", () => {
    const cases = [
      ["$eq", { qty: { $eq: 15 } }, ["beta"]],
      ["$ne", { qty: { $ne: 15 } }, ["alpha", "gamma"]],
      ["$gt", { qty: { $gt: 15 } }, ["gamma"]],
      ["$gte", { qty: { $gte: 15 } }, ["beta", "gamma"]],
      ["$lt", { qty: { $lt: 15 } }, ["alpha"]],
      ["$lte", { qty: { $lte: 15 } }, ["alpha", "beta"]],
      ["$in", { qty: { $in: [5, 30] } }, ["alpha", "gamma"]],
      ["$nin", { qty: { $nin: [5, 30] } }, ["beta"]],
      ["$and", { $and: [{ qty: { $gte: 5 } }, { tags: "red" }] }, ["alpha", "gamma"]],
      ["$or", { $or: [{ name: "alpha" }, { qty: 30 }] }, ["alpha", "gamma"]],
      ["$nor", { $nor: [{ name: "alpha" }, { qty: 30 }] }, ["beta"]],
      ["$not", { qty: { $not: { $gt: 10 } } }, ["alpha"]],
      ["$exists true", { nested: { $exists: true } }, ["alpha", "beta"]],
      ["$exists false", { nested: { $exists: false } }, ["gamma"]],
      ["$type", { when: { $type: "date" } }, ["alpha", "beta", "gamma"]],
      ["$all", { tags: { $all: ["red", "small"] } }, ["alpha"]],
      ["$size", { tags: { $size: 3 } }, ["beta"]],
      ["$mod", { qty: { $mod: [10, 5] } }, ["alpha", "beta"]],
      ["$regex", { name: { $regex: "^a" } }, ["alpha"]],
      ["$regex + $options", { name: { $regex: "^A", $options: "i" } }, ["alpha"]],
      ["dot notation", { "nested.level": 2 }, ["beta"]],
    ];

    test.each(cases)("%s selects the expected documents", async (_label, query, expected) => {
      const docs = await call("getManyDocuments", { query });
      expect(names(docs)).toEqual(expected);
    });

    test("$elemMatch narrows on array element criteria", async () => {
      await db.collection("scores").insertMany([
        { name: "s1", results: [{ v: 5 }, { v: 20 }] },
        { name: "s2", results: [{ v: 5 }, { v: 8 }] },
      ]);
      const docs = await dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "scores",
        query: { results: { $elemMatch: { v: { $gt: 10 } } } },
      });
      expect(names(docs)).toEqual(["s1"]);
    });

    test("countDocuments agrees with the documents find returns", async () => {
      const query = { qty: { $gte: 15 } };
      const docs = await call("getManyDocuments", { query });
      const count = await call("countDocuments", { query });
      expect(count).toBe(docs.length);
      expect(count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Guard rails
  // -------------------------------------------------------------------------
  describe("guard rails", () => {
    test("an all-undefined query collapses to {} and getDocument refuses to match-all", async () => {
      const doc = await call("getDocument", { query: { name: undefined } });
      expect(doc).toBeNull();
    });

    test("getManyDocuments with limit < 1 short-circuits without touching MongoDB", async () => {
      expect(await call("getManyDocuments", { query: {}, limit: 0 })).toEqual([]);
    });

    test("deleteManyDocuments applies the translated filter, not the raw one", async () => {
      await db.collection("bulk").insertMany([
        { _id: new ObjectId(), keep: true },
        { _id: new ObjectId(), keep: false },
      ]);
      const res = await dbService.deleteManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "bulk",
        query: { keep: false },
      });
      expect(res.deletedCount).toBe(1);
      expect(await db.collection("bulk").countDocuments()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Known defects — documented, not fixed (src/core is owned elsewhere)
  // -------------------------------------------------------------------------
  describe("KNOWN BUGS surfaced by running against a real database", () => {
    /**
     * KNOWN BUG #1 — write-side BSON type collapse.
     * db_service.js:258 `formatQueryObj(sanitizeWriteData(data))`
     * formatQueryObj (db_service.js:104) begins with
     * `JSON.parse(JSON.stringify(query))`, which flattens every Date and
     * ObjectId INSTANCE to a string. So a caller that hands createDocument a
     * real `new Date()` / `new ObjectId()` gets a String stored in MongoDB.
     *
     * This also makes sanitizeWriteData's careful instance-preservation guard
     * (db_service.js:29-30, whose comment says walking them "destroys them …
     * corrupting _id fields") pointless: the very next call in the same
     * expression destroys them anyway.
     *
     * Real impact in this repo: storage_service.js:43 stores
     * `bucketId: bucketObj?._id` (an ObjectId) and storage_service.js:53
     * stores `accessedAt: new Date()`. Both land in MongoDB as Strings, so
     * `_files.accessedAt` is not a date field at all and cannot be compared,
     * indexed or sorted as one.
     */
    test("KNOWN BUG: Date and ObjectId instances in a write payload are stored as strings", async () => {
      const ref = new ObjectId();
      const insertedId = await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "typecollapse",
        data: { ref, at: new Date("2021-03-04T05:06:07.000Z") },
      });

      const stored = await db.collection("typecollapse").findOne({ _id: insertedId });

      // Documenting CURRENT behavior. The correct expectations would be
      // toBeInstanceOf(ObjectId) / toBeInstanceOf(Date).
      expect(typeof stored.ref).toBe("string");
      expect(typeof stored.at).toBe("string");

      // `createdAt` is appended AFTER formatQueryObj runs, which is the only
      // reason it survives as a real Date — proof the collapse is the cause.
      expect(stored.createdAt).toBeInstanceOf(Date);
    });

    /**
     * KNOWN BUG #2 — the $oid marker cannot find what createDocument wrote.
     * Consequence of #1: the query side coerces {$oid} to a real ObjectId while
     * the stored side was collapsed to a String, and BSON never compares a
     * String equal to an ObjectId. A caller who writes a reference field
     * through this API can never query it with the documented marker.
     */
    test("KNOWN BUG: {$oid} finds nothing in a field written from an ObjectId instance", async () => {
      const ref = new ObjectId();
      await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "oidasym",
        data: { ref, label: "asym" },
      });

      const viaMarker = await dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "oidasym",
        query: { ref: { $oid: ref.toString() } },
      });
      expect(viaMarker).toEqual([]); // should have found the document

      // It is only findable by the hex string, because BOTH sides collapsed.
      const viaString = await dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "oidasym",
        query: { ref: ref.toString() },
      });
      expect(viaString).toHaveLength(1);
    });

    /**
     * KNOWN BUG #3 — the $date marker cannot find what createDocument wrote.
     * Same root cause as #2, for dates. A `$date` range filter silently returns
     * an empty page rather than an error, so it reads as "no data" to the
     * caller. Note BSON's cross-type ordering puts String before Date, so even
     * `$gte` against an epoch value matches nothing.
     */
    test("KNOWN BUG: {$date} range finds nothing in a field written from a Date instance", async () => {
      await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "dateasym",
        data: { at: new Date("2021-03-04T05:06:07.000Z"), label: "asym" },
      });

      const ranged = await dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "dateasym",
        query: { at: { $gte: { $date: "1970-01-01T00:00:00.000Z" } } },
      });
      expect(ranged).toEqual([]); // should have found the document

      // Sending the marker on the WRITE side is the only way to store a Date,
      // and then the marker works on the read side too.
      await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "dateasym",
        data: { at: { $date: "2021-03-04T05:06:07.000Z" }, label: "marked" },
      });
      const marked = await dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "dateasym",
        query: { at: { $gte: { $date: "1970-01-01T00:00:00.000Z" } } },
      });
      expect(marked.map((d) => d.label)).toEqual(["marked"]);
    });

    /**
     * KNOWN BUG #4 — a document whose _id is a 24-hex-character STRING is
     * unreachable through this API. db_service.js:55 coerces any _id the
     * driver's ObjectId.isValid() accepts, and that includes a 24-char hex
     * string, so the filter is rewritten to an ObjectId and never matches the
     * stored String. Narrow, but it is exactly the id shape an application
     * migrating off another store is most likely to carry over.
     *
     * (Non-hex string _ids are unaffected — see the passing test below.)
     */
    test("KNOWN BUG: a 24-hex-character string _id can never be read back", async () => {
      const hexStringId = "abcdefabcdefabcdefabcdef";
      expect(ObjectId.isValid(hexStringId)).toBe(true);

      await db.collection("stringids").insertOne({ _id: hexStringId, label: "hex-string-id" });

      const found = await dbService.getDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "stringids",
        query: { _id: hexStringId },
      });
      expect(found).toBeNull(); // should have found the document

      // Proof the document really is there — the raw driver finds it fine.
      expect(await db.collection("stringids").findOne({ _id: hexStringId })).not.toBeNull();
    });

    test("string _ids that are not 24-hex are left alone and work normally", async () => {
      await db.collection("stringids").insertOne({ _id: "user-abc", label: "plain-string-id" });

      const found = await dbService.getDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "stringids",
        query: { _id: "user-abc" },
      });
      expect(found).not.toBeNull();
      expect(found.label).toBe("plain-string-id");
    });
  });
});
