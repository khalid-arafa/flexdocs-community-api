/**
 * Index bootstrap against real MongoDB.
 *
 * Two mechanisms are covered:
 *   • ensureCriticalIndexes() (src/core/client.js) — the startup guarantee that
 *     system collections have their unique indexes.
 *   • ensureIndexes() (src/core/ensure_indexes.js) — the auto-indexer that
 *     reacts to the SHAPE of each incoming query.
 *
 * Both are pure side effect on the server: a mock can only record that
 * createIndex was called, never whether MongoDB accepted the spec, chose the
 * name the drop path later assumes, or refused the whole thing. That is what
 * this file checks.
 */

const {
  describeIntegration,
  projectCodeFor,
  TEST_USER_ID,
  rawDb,
  getRawClient,
  resetDb,
  closeConnections,
} = require("./helpers/db");

const PROJECT = projectCodeFor("index_bootstrap");

describeIntegration("integration: index bootstrap against real MongoDB", () => {
  let client;
  let constants;
  let ensureCriticalIndexes;
  let ensureIndexes;
  let dbService;
  let systemDb;
  let db;

  const keysOf = (indexes) => indexes.map((i) => i.key);
  const byName = (indexes, name) => indexes.find((i) => i.name === name);

  beforeAll(async () => {
    await resetDb(PROJECT);
    constants = require("../../constants");
    ({ ensureCriticalIndexes } = require("../../core/client"));
    ensureIndexes = require("../../core/ensure_indexes");
    dbService = require("../../core/db_service");
    db = await rawDb(PROJECT);
    systemDb = (await getRawClient()).db(constants.systemDatabaseName);
  });

  afterAll(async () => {
    await systemDb.dropDatabase();
    await resetDb(PROJECT);
    await closeConnections();
  });

  // -------------------------------------------------------------------------
  // ensureCriticalIndexes
  // -------------------------------------------------------------------------
  describe("ensureCriticalIndexes", () => {
    const projectsCol = () => systemDb.collection(constants.systemProjectCollectionName);
    const usersCol = () => systemDb.collection(constants.authCollectionName);

    beforeEach(async () => {
      await systemDb.dropDatabase();
    });

    test("creates a unique index on the project code", async () => {
      await ensureCriticalIndexes();

      const index = byName(await projectsCol().indexes(), "code_1");
      expect(index).toBeDefined();
      expect(index.key).toEqual({ code: 1 });
      expect(index.unique).toBe(true);
    });

    test("creates a unique, partial index on the system admin email", async () => {
      await ensureCriticalIndexes();

      const index = byName(await usersCol().indexes(), "email_1");
      expect(index).toBeDefined();
      expect(index.key).toEqual({ email: 1 });
      expect(index.unique).toBe(true);
      // Partial so several documents may omit `email` without colliding.
      expect(index.partialFilterExpression).toEqual({ email: { $exists: true } });
    });

    test("the unique index is really enforced by the server", async () => {
      await ensureCriticalIndexes();

      await projectsCol().insertOne({ code: "proj-a" });
      await expect(projectsCol().insertOne({ code: "proj-a" })).rejects.toMatchObject({
        code: 11000,
      });
    });

    test("the partial filter lets multiple email-less admins coexist", async () => {
      await ensureCriticalIndexes();

      await usersCol().insertOne({ name: "no-email-1" });
      await usersCol().insertOne({ name: "no-email-2" });
      expect(await usersCol().countDocuments()).toBe(2);

      await usersCol().insertOne({ email: "a@b.c" });
      await expect(usersCol().insertOne({ email: "a@b.c" })).rejects.toMatchObject({ code: 11000 });
    });

    test("is idempotent — running it repeatedly changes nothing", async () => {
      await ensureCriticalIndexes();
      const before = await projectsCol().indexes();

      await ensureCriticalIndexes();
      await ensureCriticalIndexes();

      expect(await projectsCol().indexes()).toEqual(before);
    });

    describe("spec-conflict recovery", () => {
      test("an existing NON-unique code_1 is dropped and recreated as unique", async () => {
        // The exact situation safeCreateIndex's code-86 branch exists for: an
        // index under the auto-generated name whose options no longer match.
        await projectsCol().createIndex({ code: 1 });
        expect(byName(await projectsCol().indexes(), "code_1").unique).toBeUndefined();

        await ensureCriticalIndexes();

        const index = byName(await projectsCol().indexes(), "code_1");
        expect(index.unique).toBe(true);
      });

      test("the recreated unique index enforces uniqueness on data inserted beforehand", async () => {
        await projectsCol().createIndex({ code: 1 });
        await projectsCol().insertOne({ code: "only-one" });

        await ensureCriticalIndexes();

        await expect(projectsCol().insertOne({ code: "only-one" })).rejects.toMatchObject({
          code: 11000,
        });
      });

      test("the drop path derives the index name the server actually assigned", async () => {
        // safeCreateIndex reconstructs "code_1" by hand from the key spec
        // (client.js:63) rather than reading it back. This asserts that guess
        // matches MongoDB's real auto-generated name — if the convention ever
        // diverged, the drop would throw and startup would fail.
        await projectsCol().createIndex({ code: 1 });
        const autoName = byName(await projectsCol().indexes(), "code_1").name;
        expect(autoName).toBe("code_1");

        await expect(ensureCriticalIndexes()).resolves.toBeUndefined();
      });

      test("an equivalent index under a DIFFERENT name is left in place, and a second one is added", async () => {
        // Characterizing real behavior: MongoDB accepts a second index over the
        // same key as long as the options differ, so no conflict is raised and
        // the collection ends up carrying BOTH. Harmless for correctness —
        // uniqueness is still enforced — but it is extra write cost that an
        // operator who hand-created an index would not expect.
        await projectsCol().createIndex({ code: 1 }, { name: "custom_code_idx" });

        await ensureCriticalIndexes();

        const indexes = await projectsCol().indexes();
        expect(byName(indexes, "custom_code_idx")).toBeDefined();
        expect(byName(indexes, "code_1").unique).toBe(true);
      });
    });

    /**
     * KNOWN BUG #6 — ensureCriticalIndexes() is called at startup and does not
     * tolerate data that already violates the uniqueness it is trying to add.
     * safeCreateIndex (client.js:58-69) only recovers from code 86; a duplicate
     * -key failure (11000) is rethrown, so the process fails to boot. Recovery
     * requires manual cleanup in the database with no guidance from the error.
     *
     * Reachable in practice: these indexes were added after the collections
     * existed, so any deployment that accumulated two projects with the same
     * code — precisely what the index is meant to prevent — cannot start.
     */
    test("KNOWN BUG: duplicate existing data makes startup index creation throw", async () => {
      await projectsCol().insertMany([{ code: "dup" }, { code: "dup" }]);

      await expect(ensureCriticalIndexes()).rejects.toMatchObject({ code: 11000 });

      // The index was not created, so the invariant is silently absent even if
      // the operator restarts past the error.
      expect(byName(await projectsCol().indexes(), "code_1")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // The auto-indexer
  // -------------------------------------------------------------------------
  describe("auto-indexer (ensure_indexes)", () => {
    let col;

    beforeEach(async () => {
      ensureIndexes.clearIndexCache();
      await db.collection("auto").drop().catch(() => {});
      col = db.collection("auto");
      await col.insertOne({ status: "open", owner: "u1", createdAt: new Date(), n: 1 });
    });

    const query = (opts) =>
      dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "auto",
        ...opts,
      });

    test("a filter plus a sort creates one compound index in that order", async () => {
      await query({ query: { status: "open" }, sort: { createdAt: -1 } });

      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }, { status: 1, createdAt: -1 }]);
    });

    test("a filter alone creates an ascending index on the first filter field", async () => {
      await query({ query: { owner: "u1" } });

      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }, { owner: 1 }]);
    });

    test("a sort alone creates an index carrying the sort direction", async () => {
      await query({ query: {}, sort: { createdAt: -1 } });

      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }, { createdAt: -1 }]);
    });

    test("filter fields are sorted, so key order in the request does not matter", async () => {
      await query({ query: { zeta: 1, alpha: 2 } });
      ensureIndexes.clearIndexCache();
      await query({ query: { alpha: 2, zeta: 1 } });

      // Both spellings of the same conjunction must settle on ONE index.
      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }, { alpha: 1 }]);
    });

    test("an _id-only filter creates no index — the built-in one already covers it", async () => {
      await query({ query: { _id: "0123456789abcdef01234567" } });

      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }]);
    });

    test("canCreateIndexes: false leaves the collection untouched", async () => {
      await query({ query: { status: "open" }, sort: { createdAt: -1 }, canCreateIndexes: false });

      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }]);
    });

    test("an existing compound index satisfies a prefix query without adding another", async () => {
      await col.createIndex({ owner: 1, createdAt: -1 });
      ensureIndexes.clearIndexCache();

      await query({ query: { owner: "u1" } });

      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }, { owner: 1, createdAt: -1 }]);
    });

    test("a missing collection is tolerated rather than throwing", async () => {
      await expect(
        dbService.getManyDocuments({
          userId: TEST_USER_ID,
          projectCode: PROJECT,
          collectionName: "never_created",
          query: { anything: 1 },
        }),
      ).resolves.toEqual([]);
    });

    test("the created index is genuinely usable by the planner", async () => {
      await query({ query: { status: "open" }, sort: { createdAt: -1 } });

      const plan = await col
        .find({ status: "open" })
        .sort({ createdAt: -1 })
        .explain("queryPlanner");
      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winning).toContain("IXSCAN");
      expect(winning).toContain("status");
    });

    /**
     * Characterizing the index cache: it is keyed only by namespace + field
     * shape and is never invalidated by anything happening in the database. An
     * index dropped by an operator (or by dropCollection) is therefore NOT
     * recreated until the process restarts or clearIndexCache() is called.
     */
    test("a dropped index is not recreated while its cache entry survives", async () => {
      await query({ query: { status: "open" } });
      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }, { status: 1 }]);

      await col.dropIndex("status_1");
      await query({ query: { status: "open" } }); // same shape → cache hit

      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }]);

      // Clearing the cache restores the behavior, confirming the cache is the
      // sole reason and nothing else changed.
      ensureIndexes.clearIndexCache();
      await query({ query: { status: "open" } });
      expect(keysOf(await col.indexes())).toEqual([{ _id: 1 }, { status: 1 }]);
    });

    /**
     * KNOWN BUG #7 — auto-indexing is driven by CALLER-CONTROLLED field names
     * with no allowlist and no cap, so every distinct filter shape a client
     * invents becomes a permanent index. MongoDB stops at 64 indexes per
     * collection, and ensure_indexes.js catches and logs that failure
     * (ensure_indexes.js:141-144) instead of surfacing it.
     *
     * A caller who can reach POST /:col with an arbitrary `query` can therefore
     * exhaust a collection's index budget with ~63 junk field names. After
     * that: every write pays for 64 index updates, no legitimate auto-index can
     * ever be created again, and nothing in the API reports a problem.
     */
    test("KNOWN BUG: arbitrary query field names grow indexes until the 64 cap, then fail silently", async () => {
      const junk = db.collection("indexflood");
      await junk.insertOne({ seed: 1 });

      for (let i = 0; i < 70; i++) {
        ensureIndexes.clearIndexCache(); // stand-in for distinct requests over time
        await ensureIndexes({
          collection: junk,
          query: { [`attackerField${i}`]: 1 },
          sort: {},
          canCreateIndexes: true,
        });
      }

      // Hard server limit reached — 63 attacker-chosen indexes plus _id_.
      expect((await junk.indexes()).length).toBe(64);

      // The overflow attempts threw on the server and were swallowed: no error
      // reached the caller, and a legitimate new shape now silently gets none.
      ensureIndexes.clearIndexCache();
      await expect(
        ensureIndexes({
          collection: junk,
          query: { legitimateBusinessField: 1 },
          sort: {},
          canCreateIndexes: true,
        }),
      ).resolves.toBeUndefined();

      expect((await junk.indexes()).some((i) => i.key.legitimateBusinessField)).toBe(false);

      // Queries still work, just unindexed — degradation, not an outage.
      await expect(
        dbService.getManyDocuments({
          userId: TEST_USER_ID,
          projectCode: PROJECT,
          collectionName: "indexflood",
          query: { seed: 1 },
        }),
      ).resolves.toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Admin index management
  // -------------------------------------------------------------------------
  describe("admin index management", () => {
    const admin = (fn, extra) =>
      dbService[fn]({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "manual",
        ...extra,
      });

    beforeEach(async () => {
      await db.collection("manual").drop().catch(() => {});
      await db.collection("manual").insertOne({ email: "a@b.c" });
    });

    test("createIndex returns the server-assigned name and listIndexes reflects it", async () => {
      const created = await admin("createIndex", { keys: { email: 1 }, options: { unique: true } });
      expect(created.success).toBe(true);
      expect(created.name).toBe("email_1");

      const listed = await admin("listIndexes");
      expect(listed.success).toBe(true);
      expect(byName(listed.indexes, "email_1").unique).toBe(true);
    });

    test("a unique index created this way is enforced", async () => {
      await admin("createIndex", { keys: { email: 1 }, options: { unique: true } });

      await expect(db.collection("manual").insertOne({ email: "a@b.c" })).rejects.toMatchObject({
        code: 11000,
      });
    });

    test("createIndex reports the real server error instead of throwing", async () => {
      await db.collection("manual").insertOne({ email: "a@b.c" }); // duplicate

      const result = await admin("createIndex", { keys: { email: 1 }, options: { unique: true } });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/duplicate key/i);
    });

    test("dropIndex removes it, and the _id_ index is protected", async () => {
      await admin("createIndex", { keys: { email: 1 } });

      expect(await admin("dropIndex", { name: "email_1" })).toEqual({ success: true });
      expect(byName((await admin("listIndexes")).indexes, "email_1")).toBeUndefined();

      const protectedDrop = await admin("dropIndex", { name: "_id_" });
      expect(protectedDrop.success).toBe(false);
      expect(byName((await admin("listIndexes")).indexes, "_id_")).toBeDefined();
    });
  });
});
