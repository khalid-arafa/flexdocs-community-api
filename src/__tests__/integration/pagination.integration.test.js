/**
 * Pagination against real MongoDB: offset (skip/limit) and the opt-in keyset
 * cursor from src/utils/cursor.js.
 *
 * The cursor helpers are pure functions, so the unit suite could only ever
 * check the FILTER they build. What actually matters is whether paging a real
 * collection with them visits every document exactly once — including while the
 * collection is being written to, which is the entire reason keyset pagination
 * exists. That can only be tested here.
 *
 * fetchCursorPage() below mirrors what src/routes/db.routes.js does around
 * lines 168-199, so the sequences under test are the ones the route produces.
 */

const {
  describeIntegration,
  projectCodeFor,
  TEST_USER_ID,
  rawDb,
  resetDb,
  closeConnections,
} = require("./helpers/db");

const PROJECT = projectCodeFor("pagination");
const COL = "items";
const TOTAL = 250;

describeIntegration("integration: pagination against real MongoDB", () => {
  let dbService;
  let cursorUtil;
  let db;

  const fetchPage = ({ query = {}, sort = {}, skip = 0, limit = 10, collectionName = COL }) =>
    dbService.getManyDocuments({
      userId: TEST_USER_ID,
      projectCode: PROJECT,
      collectionName,
      query,
      sort,
      skip,
      limit,
    });

  /** One page of the keyset path, exactly as db.routes.js assembles it. */
  async function fetchCursorPage({ query = {}, sort = {}, cursorStr, limit = 10, collectionName = COL }) {
    const seek = cursorUtil.buildCursorSeek({ query, sort, cursorStr });
    if (seek.invalidCursor) return { invalidCursor: true };

    const docs = await dbService.getManyDocuments({
      userId: TEST_USER_ID,
      projectCode: PROJECT,
      collectionName,
      query: seek.query,
      sort: seek.sort,
      skip: 0,
      limit,
    });

    return {
      docs,
      nextCursor: docs.length === limit ? cursorUtil.encodeCursor(docs[docs.length - 1], seek.primaryField) : null,
    };
  }

  /** Walks the whole collection through the cursor path. */
  async function drainWithCursor({ query = {}, sort = {}, limit = 10, collectionName = COL, maxPages = 200 }) {
    const seen = [];
    let cursorStr;
    for (let page = 0; page < maxPages; page++) {
      const { docs, nextCursor } = await fetchCursorPage({ query, sort, cursorStr, limit, collectionName });
      seen.push(...docs);
      if (!nextCursor) break;
      cursorStr = nextCursor;
    }
    return seen;
  }

  /** Walks the whole collection through the offset path. */
  async function drainWithSkip({ query = {}, sort = {}, limit = 10, collectionName = COL }) {
    const seen = [];
    for (let skip = 0; ; skip += limit) {
      const docs = await fetchPage({ query, sort, skip, limit, collectionName });
      seen.push(...docs);
      if (docs.length < limit) break;
    }
    return seen;
  }

  beforeAll(async () => {
    await resetDb(PROJECT);
    dbService = require("../../core/db_service");
    cursorUtil = require("../../utils/cursor");
    db = await rawDb(PROJECT);

    // seq is unique and ordered; `bucket` deliberately repeats so the _id
    // tiebreaker gets exercised; `when` is a genuine BSON Date.
    const docs = [];
    for (let i = 0; i < TOTAL; i++) {
      docs.push({
        seq: i,
        bucket: `b${i % 5}`,
        even: i % 2 === 0,
        when: new Date(Date.UTC(2020, 0, 1 + Math.floor(i / 10))),
      });
    }
    await db.collection(COL).insertMany(docs);
  });

  afterAll(async () => {
    await resetDb(PROJECT);
    await closeConnections();
  });

  // -------------------------------------------------------------------------
  // Offset pagination
  // -------------------------------------------------------------------------
  describe("skip/limit correctness", () => {
    test("the first page starts at the beginning", async () => {
      const docs = await fetchPage({ sort: { seq: 1 }, skip: 0, limit: 10 });
      expect(docs.map((d) => d.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    test("a deep page lands on the right window", async () => {
      // Page 21 of 10 — deep enough that an off-by-one would be invisible on
      // page 1 but obvious here.
      const docs = await fetchPage({ sort: { seq: 1 }, skip: 200, limit: 10 });
      expect(docs.map((d) => d.seq)).toEqual([200, 201, 202, 203, 204, 205, 206, 207, 208, 209]);
    });

    test("page boundaries do not overlap or leave gaps", async () => {
      const pageA = await fetchPage({ sort: { seq: 1 }, skip: 90, limit: 10 });
      const pageB = await fetchPage({ sort: { seq: 1 }, skip: 100, limit: 10 });

      expect(pageA[pageA.length - 1].seq).toBe(99);
      expect(pageB[0].seq).toBe(100);
      const overlap = pageA.filter((a) => pageB.some((b) => b.seq === a.seq));
      expect(overlap).toEqual([]);
    });

    test("the final page is short and the one past the end is empty", async () => {
      const last = await fetchPage({ sort: { seq: 1 }, skip: 245, limit: 10 });
      expect(last.map((d) => d.seq)).toEqual([245, 246, 247, 248, 249]);

      expect(await fetchPage({ sort: { seq: 1 }, skip: TOTAL, limit: 10 })).toEqual([]);
      expect(await fetchPage({ sort: { seq: 1 }, skip: TOTAL * 10, limit: 10 })).toEqual([]);
    });

    test("draining by skip/limit visits every document exactly once", async () => {
      const seen = await drainWithSkip({ sort: { seq: 1 }, limit: 17 });
      expect(seen).toHaveLength(TOTAL);
      expect(seen.map((d) => d.seq)).toEqual([...Array(TOTAL).keys()]);
    });

    test("a filter is applied before paging, not after", async () => {
      const docs = await fetchPage({ query: { even: true }, sort: { seq: 1 }, skip: 10, limit: 5 });
      expect(docs.map((d) => d.seq)).toEqual([20, 22, 24, 26, 28]);

      const count = await dbService.countDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: COL,
        query: { even: true },
      });
      expect(count).toBe(TOTAL / 2);
    });

    test("descending sort pages from the far end", async () => {
      const docs = await fetchPage({ sort: { seq: -1 }, skip: 0, limit: 5 });
      expect(docs.map((d) => d.seq)).toEqual([249, 248, 247, 246, 245]);
    });
  });

  // -------------------------------------------------------------------------
  // Keyset cursor pagination
  // -------------------------------------------------------------------------
  describe("keyset cursor correctness", () => {
    test("the cursor path returns the same logical sequence as skip/limit", async () => {
      const viaSkip = await drainWithSkip({ sort: { seq: 1 }, limit: 10 });
      const viaCursor = await drainWithCursor({ sort: { seq: 1 }, limit: 10 });

      expect(viaCursor.map((d) => d.seq)).toEqual(viaSkip.map((d) => d.seq));
      expect(viaCursor).toHaveLength(TOTAL);
    });

    test("the sequences agree for a descending sort too", async () => {
      const viaSkip = await drainWithSkip({ sort: { seq: -1 }, limit: 13 });
      const viaCursor = await drainWithCursor({ sort: { seq: -1 }, limit: 13 });

      expect(viaCursor.map((d) => d.seq)).toEqual(viaSkip.map((d) => d.seq));
      expect(viaCursor[0].seq).toBe(249);
    });

    test("paging by _id (the default sort) covers everything exactly once", async () => {
      const viaCursor = await drainWithCursor({ sort: {}, limit: 25 });
      expect(viaCursor).toHaveLength(TOTAL);
      expect(new Set(viaCursor.map((d) => String(d._id))).size).toBe(TOTAL);
    });

    test("a duplicated sort value is disambiguated by the _id tiebreaker", async () => {
      // `bucket` has only 5 distinct values across 250 documents, so without
      // the _id tiebreaker a seek on bucket alone would either loop forever or
      // skip whole runs.
      const viaCursor = await drainWithCursor({ sort: { bucket: 1 }, limit: 10 });

      expect(viaCursor).toHaveLength(TOTAL);
      expect(new Set(viaCursor.map((d) => String(d._id))).size).toBe(TOTAL);

      const buckets = viaCursor.map((d) => d.bucket);
      expect([...buckets].sort()).toEqual(buckets); // still globally ordered
    });

    test("paging on a Date field works via the $date marker in the cursor", async () => {
      const viaCursor = await drainWithCursor({ sort: { when: 1 }, limit: 10 });
      expect(viaCursor).toHaveLength(TOTAL);

      const times = viaCursor.map((d) => d.when.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    test("a filter combines with the seek condition instead of replacing it", async () => {
      const viaCursor = await drainWithCursor({ query: { even: true }, sort: { seq: 1 }, limit: 10 });

      expect(viaCursor).toHaveLength(TOTAL / 2);
      expect(viaCursor.every((d) => d.even)).toBe(true);
      expect(viaCursor.map((d) => d.seq).slice(0, 3)).toEqual([0, 2, 4]);
    });

    test("the last page reports no next cursor", async () => {
      // 250 documents at 125 per page: page 2 is full, so the route's
      // "full page might mean more" heuristic issues one more (empty) request.
      const p1 = await fetchCursorPage({ sort: { seq: 1 }, limit: 125 });
      expect(p1.nextCursor).not.toBeNull();

      const p2 = await fetchCursorPage({ sort: { seq: 1 }, cursorStr: p1.nextCursor, limit: 125 });
      expect(p2.docs).toHaveLength(125);
      expect(p2.nextCursor).not.toBeNull();

      const p3 = await fetchCursorPage({ sort: { seq: 1 }, cursorStr: p2.nextCursor, limit: 125 });
      expect(p3.docs).toEqual([]);
      expect(p3.nextCursor).toBeNull();
    });

    test("a malformed cursor is reported rather than silently ignored", async () => {
      expect(await fetchCursorPage({ sort: { seq: 1 }, cursorStr: "not-a-cursor" })).toEqual({
        invalidCursor: true,
      });
      expect(
        await fetchCursorPage({
          sort: { seq: 1 },
          cursorStr: Buffer.from(JSON.stringify({ id: "nope" })).toString("base64url"),
        }),
      ).toEqual({ invalidCursor: true });
    });
  });

  // -------------------------------------------------------------------------
  // The reason keyset pagination exists
  // -------------------------------------------------------------------------
  describe("stability while the collection is being written", () => {
    const CONCUR = "concurrent";

    beforeEach(async () => {
      await db.collection(CONCUR).deleteMany({});
      await db
        .collection(CONCUR)
        .insertMany(Array.from({ length: 40 }, (_, i) => ({ seq: i * 10 })));
    });

    test("skip/limit repeats rows when a document is inserted ahead of the window", async () => {
      const page1 = await fetchPage({ collectionName: CONCUR, sort: { seq: 1 }, skip: 0, limit: 10 });
      expect(page1.map((d) => d.seq)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

      // A concurrent writer inserts a row that sorts BEFORE everything read.
      await db.collection(CONCUR).insertOne({ seq: -1 });

      const page2 = await fetchPage({ collectionName: CONCUR, sort: { seq: 1 }, skip: 10, limit: 10 });

      // Everything shifted by one, so seq 90 comes back a second time.
      expect(page2.map((d) => d.seq)).toContain(90);
      const repeated = page1.filter((a) => page2.some((b) => b.seq === a.seq));
      expect(repeated.length).toBeGreaterThan(0);
    });

    test("the cursor path does not repeat rows under the same insert", async () => {
      const p1 = await fetchCursorPage({ collectionName: CONCUR, sort: { seq: 1 }, limit: 10 });
      expect(p1.docs.map((d) => d.seq)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

      await db.collection(CONCUR).insertOne({ seq: -1 });

      const p2 = await fetchCursorPage({
        collectionName: CONCUR,
        sort: { seq: 1 },
        cursorStr: p1.nextCursor,
        limit: 10,
      });

      // The seek is anchored to seq > 90, so the insert behind it is invisible.
      expect(p2.docs.map((d) => d.seq)).toEqual([100, 110, 120, 130, 140, 150, 160, 170, 180, 190]);
      const repeated = p1.docs.filter((a) => p2.docs.some((b) => b.seq === a.seq));
      expect(repeated).toEqual([]);
    });

    test("skip/limit drops a row when a document ahead of the window is deleted", async () => {
      const page1 = await fetchPage({ collectionName: CONCUR, sort: { seq: 1 }, skip: 0, limit: 10 });
      await db.collection(CONCUR).deleteOne({ seq: 0 });
      const page2 = await fetchPage({ collectionName: CONCUR, sort: { seq: 1 }, skip: 10, limit: 10 });

      // seq 100 is never returned by either page — it slid into page 1's window.
      const seen = [...page1, ...page2].map((d) => d.seq);
      expect(seen).not.toContain(100);
    });

    test("the cursor path still returns that row after the same delete", async () => {
      const p1 = await fetchCursorPage({ collectionName: CONCUR, sort: { seq: 1 }, limit: 10 });
      await db.collection(CONCUR).deleteOne({ seq: 0 });
      const p2 = await fetchCursorPage({
        collectionName: CONCUR,
        sort: { seq: 1 },
        cursorStr: p1.nextCursor,
        limit: 10,
      });

      expect(p2.docs.map((d) => d.seq)[0]).toBe(100);
    });

    test("a full drain under continuous inserts never yields a duplicate", async () => {
      const seen = [];
      let cursorStr;
      let inserted = 1000;

      for (let page = 0; page < 20; page++) {
        const { docs, nextCursor } = await fetchCursorPage({
          collectionName: CONCUR,
          sort: { seq: 1 },
          cursorStr,
          limit: 7,
        });
        seen.push(...docs);
        // A writer appends between every page request.
        await db.collection(CONCUR).insertOne({ seq: inserted++ });
        if (!nextCursor) break;
        cursorStr = nextCursor;
      }

      const ids = seen.map((d) => String(d._id));
      expect(new Set(ids).size).toBe(ids.length);
      // Every original row is accounted for, in order.
      const originals = seen.filter((d) => d.seq < 1000).map((d) => d.seq);
      expect(originals).toEqual([...originals].sort((a, b) => a - b));
    });
  });
});
