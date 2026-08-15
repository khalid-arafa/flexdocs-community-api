/**
 * Injection defense, proven by attacking a REAL MongoDB.
 *
 * A test that only asserts "the sanitizer removed the key" proves nothing about
 * whether the database would have honored it. So each block below first
 * establishes a CONTROL — the raw driver running the same payload, showing the
 * server really does execute it — and only then shows the defended path
 * refusing it. Without the control, a passing test could just mean the
 * operator was inert on this server version.
 *
 * The HTTP tests mount the genuine sanitize_query middleware in front of the
 * genuine db_service, so the assertion covers the real request chain rather
 * than a hand-built call.
 */

const express = require("express");
const request = require("supertest");
const { ObjectId } = require("mongodb");

const {
  describeIntegration,
  projectCodeFor,
  TEST_USER_ID,
  rawDb,
  resetDb,
  closeConnections,
} = require("./helpers/db");

const PROJECT = projectCodeFor("injection_defense");
const COL = "accounts";

describeIntegration("integration: injection defense against real MongoDB", () => {
  let dbService;
  let sanitizeMw;
  let db;
  let app;

  const call = (fn, extra) =>
    dbService[fn]({
      userId: TEST_USER_ID,
      projectCode: PROJECT,
      collectionName: COL,
      ...extra,
    });

  beforeAll(async () => {
    await resetDb(PROJECT);
    dbService = require("../../core/db_service");
    sanitizeMw = require("../../middleware/sanitize_query.middleware");
    db = await rawDb(PROJECT);

    await db.collection(COL).insertMany([
      { _id: new ObjectId(), user: "alice", role: "user", secret: "alice-token", balance: 10 },
      { _id: new ObjectId(), user: "bob", role: "user", secret: "bob-token", balance: 20 },
      { _id: new ObjectId(), user: "root", role: "admin", secret: "root-token", balance: 999 },
    ]);

    // The real middleware in front of the real data layer.
    app = express();
    app.use(express.json());
    app.use(sanitizeMw.sanitizeQuery);
    app.post("/query", async (req, res) => {
      try {
        const docs = await call("getManyDocuments", { query: req.body.query || {} });
        res.status(200).json({ users: docs.map((d) => d.user).sort() });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    app.post("/add", async (req, res) => {
      try {
        const id = await dbService.createDocument({
          userId: TEST_USER_ID,
          projectCode: PROJECT,
          collectionName: "written",
          data: req.body,
        });
        res.status(200).json({ _id: String(id) });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  });

  afterAll(async () => {
    await resetDb(PROJECT);
    await closeConnections();
  });

  // -------------------------------------------------------------------------
  // Controls — the server really would run these
  // -------------------------------------------------------------------------
  describe("control: this MongoDB server does execute JavaScript operators", () => {
    test("$where executes when the raw driver sends it", async () => {
      const docs = await db
        .collection(COL)
        .find({ $where: "this.role === 'admin'" })
        .toArray();
      expect(docs.map((d) => d.user)).toEqual(["root"]);
    });

    test("$function executes when the raw driver sends it", async () => {
      const docs = await db
        .collection(COL)
        .find({
          $expr: {
            $function: { body: "function (r) { return r === 'admin'; }", args: ["$role"], lang: "js" },
          },
        })
        .toArray();
      expect(docs.map((d) => d.user)).toEqual(["root"]);
    });
  });

  // -------------------------------------------------------------------------
  // db_service refuses JS-execution operators outright
  // -------------------------------------------------------------------------
  describe("db_service rejects JavaScript-execution operators", () => {
    const payloads = [
      ["$where", { $where: "this.role === 'admin'" }],
      ["$function", { $expr: { $function: { body: "function(){return true}", args: [], lang: "js" } } }],
      ["$accumulator", { $accumulator: { init: "function(){return 0}", accumulate: "function(){}", lang: "js" } }],
      ["nested $where under $or", { $or: [{ user: "alice" }, { $where: "true" }] }],
      ["deeply nested $where", { $and: [{ $or: [{ $and: [{ $where: "true" }] }] }] }],
    ];

    test.each(payloads)("getManyDocuments throws on %s and returns no data", async (_l, query) => {
      await expect(call("getManyDocuments", { query })).rejects.toThrow(/Forbidden operator/);
    });

    test.each(payloads)("countDocuments throws on %s", async (_l, query) => {
      await expect(call("countDocuments", { query })).rejects.toThrow(/Forbidden operator/);
    });

    test("getDocument swallows the rejection and leaks nothing", async () => {
      // getDocument catches internally and returns null rather than throwing.
      const doc = await call("getDocument", { query: { $where: "this.role === 'admin'" } });
      expect(doc).toBeNull();
    });

    test("deleteManyDocuments refuses a $where filter and destroys nothing", async () => {
      const before = await db.collection(COL).countDocuments();
      await expect(
        call("deleteManyDocuments", { query: { $where: "true" } }),
      ).rejects.toThrow(/Forbidden operator/);
      expect(await db.collection(COL).countDocuments()).toBe(before);
    });

    test("updateManyDocuments refuses a $where filter and mutates nothing", async () => {
      await expect(
        dbService.updateManyDocuments(TEST_USER_ID, PROJECT, COL, { $where: "true" }, { role: "admin" }),
      ).rejects.toThrow(/Forbidden operator/);
      expect(await db.collection(COL).countDocuments({ role: "admin" })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Full HTTP chain
  // -------------------------------------------------------------------------
  describe("over HTTP through the real sanitize middleware", () => {
    test("a $where attack does not execute and does not leak the admin row", async () => {
      const res = await request(app)
        .post("/query")
        .send({ query: { $where: "this.role === 'admin'" } });

      expect(res.status).toBe(200);
      // The middleware strips $where before db_service sees it, leaving {}.
      // Nothing was executed as JavaScript — and critically, the response is
      // NOT the attacker's intended selection of just the admin row.
      expect(res.body.users).not.toEqual(["root"]);
    });

    test("$where stripping widens the filter to match-all rather than rejecting it", async () => {
      // Documenting real, slightly surprising behavior: because the middleware
      // DROPS the unknown operator instead of refusing the request, a query
      // consisting solely of $where degrades to {} — every document in the
      // page, not an error. Not an escalation (the caller was already
      // authorized to read this collection and {} is the route's default
      // query), but callers should not read an empty-looking filter as "denied".
      const res = await request(app)
        .post("/query")
        .send({ query: { $where: "this.role === 'admin'" } });

      expect(res.body.users).toEqual(["alice", "bob", "root"]);
    });

    test("an operator-injection attempt on a normal field is preserved but harmless", async () => {
      // {$ne: null} on a scalar field is an ALLOWED operator by design; it is
      // an authentication-bypass classic only when it reaches a login filter.
      // Here it is simply an honest filter, and dbRules — not the sanitizer —
      // is what decides whether the caller may run it at all.
      const res = await request(app).post("/query").send({ query: { role: { $ne: "admin" } } });
      expect(res.body.users).toEqual(["alice", "bob"]);
    });

    test("a $regex bomb is refused with 400 before reaching MongoDB", async () => {
      const res = await request(app)
        .post("/query")
        .send({ query: { user: { $regex: "(a+)+$" } } });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/catastrophic backtracking/);
    });

    test("an over-long $regex is refused with 400", async () => {
      const res = await request(app)
        .post("/query")
        .send({ query: { user: { $regex: "a".repeat(sanitizeMw.MAX_REGEX_LENGTH + 1) } } });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at most/);
    });

    test("a safe $regex is allowed through and really runs on the server", async () => {
      const res = await request(app).post("/query").send({ query: { user: { $regex: "^a" } } });
      expect(res.status).toBe(200);
      expect(res.body.users).toEqual(["alice"]);
    });

    test("nesting beyond the depth cap is refused with 400", async () => {
      let deep = { user: "alice" };
      for (let i = 0; i < sanitizeMw.MAX_QUERY_DEPTH + 2; i++) deep = { $and: [deep] };

      const res = await request(app).post("/query").send({ query: deep });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/nesting exceeds/);
    });

    test("the coercion markers survive sanitization and still work end to end", async () => {
      const target = await db.collection(COL).findOne({ user: "bob" });
      const res = await request(app)
        .post("/query")
        .send({ query: { _id: { $oid: target._id.toString() } } });

      expect(res.status).toBe(200);
      expect(res.body.users).toEqual(["bob"]);
    });
  });

  // -------------------------------------------------------------------------
  // Write-payload operator stripping
  // -------------------------------------------------------------------------
  describe("write payloads cannot smuggle update operators", () => {
    test("$set in an add payload is stripped, so no extra field is stored", async () => {
      const res = await request(app)
        .post("/add")
        .send({ user: "mallory", $set: { role: "admin" } });

      expect(res.status).toBe(200);
      const stored = await db.collection("written").findOne({ _id: new ObjectId(res.body._id) });
      expect(stored.user).toBe("mallory");
      expect(stored.role).toBeUndefined();
      expect(stored.$set).toBeUndefined();
    });

    test("operators nested inside a sub-document and an array are stripped too", async () => {
      const id = await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "written",
        data: {
          user: "nested",
          profile: { $inc: { credits: 100 }, nickname: "n" },
          items: [{ $push: { x: 1 }, sku: "s1" }],
        },
      });

      const stored = await db.collection("written").findOne({ _id: id });
      expect(stored.profile).toEqual({ nickname: "n" });
      expect(stored.items).toEqual([{ sku: "s1" }]);
    });

    test("$oid and $date markers are deliberately NOT stripped from write data", async () => {
      const chosen = new ObjectId();
      const id = await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "written",
        data: { _id: { $oid: chosen.toString() }, at: { $date: "2023-05-06T07:08:09.000Z" } },
      });

      expect(id.toString()).toBe(chosen.toString());
      const stored = await db.collection("written").findOne({ _id: chosen });
      expect(stored.at).toBeInstanceOf(Date);
      expect(stored.at.toISOString()).toBe("2023-05-06T07:08:09.000Z");
    });

    test("a JS-execution operator in write data is rejected loudly, not silently dropped", async () => {
      // sanitizeWriteData intentionally KEEPS $where/$function/$accumulator so
      // that formatQueryObj throws instead of quietly accepting the document.
      await expect(
        dbService.createDocument({
          userId: TEST_USER_ID,
          projectCode: PROJECT,
          collectionName: "written",
          data: { user: "evil", $where: "1==1" },
        }),
      ).rejects.toThrow(/Forbidden operator/);

      expect(await db.collection("written").countDocuments({ user: "evil" })).toBe(0);
    });

    test("updateDocument strips operators from updateData and only $sets real fields", async () => {
      const id = await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "written",
        data: { user: "target", balance: 1 },
      });

      await dbService.updateDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "written",
        query: { _id: id.toString() },
        updateData: { $rename: { user: "pwned" }, $inc: { balance: 999 }, note: "ok" },
      });

      const stored = await db.collection("written").findOne({ _id: id });
      expect(stored.user).toBe("target"); // $rename did not fire
      expect(stored.balance).toBe(1); // $inc did not fire
      expect(stored.note).toBe("ok"); // the honest field was written
    });

    test("a replace payload cannot smuggle operators either", async () => {
      const id = await dbService.createDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "written",
        data: { user: "replaceme", balance: 5 },
      });

      await dbService.updateDocument({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "written",
        query: { _id: id.toString() },
        updateData: { $unset: { balance: "" }, user: "replaced" },
        type: "replace",
      });

      const stored = await db.collection("written").findOne({ _id: id });
      expect(stored.user).toBe("replaced");
      // replaceOne swaps the whole document, so `balance` is gone because it
      // was absent from the replacement — not because $unset executed.
      expect(stored.balance).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Reserved-collection guards, exercised against real namespaces
  // -------------------------------------------------------------------------
  describe("reserved collections cannot be dropped or renamed", () => {
    test("dropCollection refuses a system collection that really exists", async () => {
      await db.collection("_users").insertOne({ email: "a@b.c" });

      const result = await dbService.dropCollection({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: "_users",
      });

      expect(result.success).toBe(false);
      expect(await db.collection("_users").countDocuments()).toBe(1);
    });

    test("renameCollection refuses to rename onto a system name", async () => {
      await db.collection("harmless").insertOne({ x: 1 });

      const result = await dbService.renameCollection({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        oldName: "harmless",
        newName: "_users",
      });

      expect(result.success).toBe(false);
      expect(await db.collection("harmless").countDocuments()).toBe(1);
    });
  });
});
