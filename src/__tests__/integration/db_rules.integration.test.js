/**
 * Database rules evaluated over REAL documents.
 *
 * db_rules_service is pure JEXL, so it can be unit-tested with hand-written
 * objects — and it is. What those tests cannot show is how the rules behave
 * against documents as MongoDB actually returns them, where `_id` and reference
 * fields are ObjectId instances and dates are Date instances rather than the
 * plain strings a hand-written fixture would use. Type coercion inside a rule
 * expression is exactly where an authorization check quietly flips.
 *
 * The HTTP block mounts the genuine DbRulesService.middleware() over documents
 * fetched from the genuine db_service.
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

const PROJECT = projectCodeFor("db_rules");
const COL = "posts";

describeIntegration("integration: db rules over real documents", () => {
  let DbRulesService;
  let dbService;
  let db;

  const aliceId = new ObjectId();
  const bobId = new ObjectId();
  let alicePost;
  let bobPost;
  let draftPost;

  const load = (query) =>
    dbService.getDocument({
      userId: TEST_USER_ID,
      projectCode: PROJECT,
      collectionName: COL,
      query,
    });

  beforeAll(async () => {
    await resetDb(PROJECT);
    DbRulesService = require("../../core/db_rules_service");
    dbService = require("../../core/db_service");
    db = await rawDb(PROJECT);

    // Seeded raw so ownerId is a genuine ObjectId and publishedAt a genuine Date.
    await db.collection(COL).insertMany([
      {
        _id: new ObjectId(),
        title: "alice-public",
        ownerId: aliceId,
        isPublic: true,
        status: "published",
        publishedAt: new Date("2023-01-01T00:00:00.000Z"),
        views: 100,
      },
      {
        _id: new ObjectId(),
        title: "bob-private",
        ownerId: bobId,
        isPublic: false,
        status: "published",
        publishedAt: new Date("2023-06-01T00:00:00.000Z"),
        views: 5,
      },
      {
        _id: new ObjectId(),
        title: "alice-draft",
        ownerId: aliceId,
        isPublic: false,
        status: "draft",
        publishedAt: null,
        views: 0,
      },
    ]);

    alicePost = await load({ title: "alice-public" });
    bobPost = await load({ title: "bob-private" });
    draftPost = await load({ title: "alice-draft" });
  });

  afterAll(async () => {
    await resetDb(PROJECT);
    await closeConnections();
  });

  const checkDoc = (rules, doc, { user = null, action = "read" } = {}) =>
    new DbRulesService(rules).check({ action, path: `/${COL}/${doc._id}`, user, doc });

  const checkCollection = (rules, { user = null, action = "read" } = {}) =>
    new DbRulesService(rules).check({ action, path: `/${COL}`, user });

  // -------------------------------------------------------------------------
  // Default-deny posture
  // -------------------------------------------------------------------------
  describe("default-deny posture", () => {
    test("a collection with no rules at all is not readable", async () => {
      expect(await checkCollection({})).toBe(false);
    });

    test("a real document from a collection with no rules is not readable", async () => {
      expect(await checkDoc({}, alicePost)).toBe(false);
    });

    test("rules for a DIFFERENT collection do not grant access to this one", async () => {
      expect(await checkDoc({ "/comments": true }, alicePost)).toBe(false);
    });

    test("a rule object that omits the requested action denies it", async () => {
      const rules = { [`/${COL}`]: { read: true } };
      expect(await checkDoc(rules, alicePost, { action: "read" })).toBe(true);
      expect(await checkDoc(rules, alicePost, { action: "delete" })).toBe(false);
      expect(await checkDoc(rules, alicePost, { action: "update" })).toBe(false);
      expect(await checkDoc(rules, alicePost, { action: "add" })).toBe(false);
    });

    test("an unparsable expression denies rather than throwing", async () => {
      expect(await checkDoc({ [`/${COL}`]: { read: "this is ((not jexl" } }, alicePost)).toBe(false);
    });

    test("an expression referencing a null user denies instead of erroring", async () => {
      expect(
        await checkDoc({ [`/${COL}`]: { read: "user.id == doc.ownerId" } }, alicePost, { user: null }),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Rules over real BSON values
  // -------------------------------------------------------------------------
  describe("expressions evaluated against real BSON values", () => {
    test("an ObjectId ownerId compares equal to the user's hex id", async () => {
      // Worth pinning down: `doc.ownerId` arrives from MongoDB as an ObjectId
      // instance while `user.id` is a hex string from the JWT. JEXL's `==`
      // coerces the ObjectId via toString, so ownership rules written the
      // obvious way DO work — but only because of that coercion.
      const rules = { [`/${COL}`]: { read: "doc.ownerId == user.id" } };

      expect(await checkDoc(rules, alicePost, { user: { id: aliceId.toString() } })).toBe(true);
      expect(await checkDoc(rules, alicePost, { user: { id: bobId.toString() } })).toBe(false);
      expect(await checkDoc(rules, bobPost, { user: { id: bobId.toString() } })).toBe(true);
    });

    test("the document's own ObjectId _id compares equal to a hex string", async () => {
      const rules = { [`/${COL}`]: { read: "doc._id == user.id" } };

      expect(await checkDoc(rules, alicePost, { user: { id: alicePost._id.toString() } })).toBe(true);
      expect(await checkDoc(rules, alicePost, { user: { id: bobPost._id.toString() } })).toBe(false);
    });

    test("a boolean field from MongoDB drives a public/private rule", async () => {
      const rules = { [`/${COL}`]: { read: "doc.isPublic == true" } };

      expect(await checkDoc(rules, alicePost)).toBe(true);
      expect(await checkDoc(rules, bobPost)).toBe(false);
    });

    test("a numeric comparison uses the stored number, not its string form", async () => {
      const rules = { [`/${COL}`]: { read: "doc.views > 50" } };

      expect(await checkDoc(rules, alicePost)).toBe(true); // 100
      expect(await checkDoc(rules, bobPost)).toBe(false); // 5
    });

    test("a null Date field is distinguishable from a set one", async () => {
      const rules = { [`/${COL}`]: { read: "doc.publishedAt != null" } };

      expect(await checkDoc(rules, alicePost)).toBe(true);
      expect(await checkDoc(rules, draftPost)).toBe(false);
    });

    test("compound ownership-or-public rules behave over real documents", async () => {
      const rules = {
        [`/${COL}`]: { read: "doc.isPublic == true || doc.ownerId == user.id" },
      };

      expect(await checkDoc(rules, alicePost, { user: { id: bobId.toString() } })).toBe(true);
      expect(await checkDoc(rules, bobPost, { user: { id: bobId.toString() } })).toBe(true);
      expect(await checkDoc(rules, bobPost, { user: { id: aliceId.toString() } })).toBe(false);
      expect(await checkDoc(rules, draftPost, { user: { id: aliceId.toString() } })).toBe(true);
    });

    test("a rule may read the request body as well as the document", async () => {
      const rules = { [`/${COL}`]: { update: "body.status == 'published' && doc.ownerId == user.id" } };
      const svc = new DbRulesService(rules);

      const allowed = await svc.check({
        action: "update",
        path: `/${COL}/${alicePost._id}`,
        user: { id: aliceId.toString() },
        doc: alicePost,
        body: { status: "published" },
      });
      const refused = await svc.check({
        action: "update",
        path: `/${COL}/${alicePost._id}`,
        user: { id: aliceId.toString() },
        doc: alicePost,
        body: { status: "draft" },
      });

      expect(allowed).toBe(true);
      expect(refused).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Path specificity
  // -------------------------------------------------------------------------
  describe("path specificity over real document ids", () => {
    test("a rule for one specific document id beats the collection rule", async () => {
      const rules = {
        [`/${COL}`]: { read: true },
        [`/${COL}/${alicePost._id}`]: { read: false },
      };

      expect(await checkDoc(rules, alicePost)).toBe(false);
      expect(await checkDoc(rules, bobPost)).toBe(true);
    });

    test("the [id] wildcard applies to every document and beats the collection rule", async () => {
      const rules = {
        [`/${COL}`]: { read: true },
        [`/${COL}/[id]`]: { read: "doc.isPublic == true" },
      };

      expect(await checkDoc(rules, alicePost)).toBe(true);
      expect(await checkDoc(rules, bobPost)).toBe(false);
    });

    test("a specific id beats the [id] wildcard", async () => {
      const rules = {
        [`/${COL}/[id]`]: { read: false },
        [`/${COL}/${bobPost._id}`]: { read: true },
      };

      expect(await checkDoc(rules, bobPost)).toBe(true);
      expect(await checkDoc(rules, alicePost)).toBe(false);
    });

    test("a collection-level check is unaffected by document-level rules", async () => {
      expect(await checkCollection({ [`/${COL}/[id]`]: { read: true } })).toBe(false);
      expect(await checkCollection({ [`/${COL}`]: { read: true } })).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Filtering a real result set
  // -------------------------------------------------------------------------
  describe("applied to a real query result set", () => {
    test("rules filter a page of documents down to the visible subset", async () => {
      const docs = await dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: COL,
        query: {},
        sort: { title: 1 },
      });
      expect(docs).toHaveLength(3);

      const svc = new DbRulesService({
        [`/${COL}`]: { read: "doc.isPublic == true || doc.ownerId == user.id" },
      });
      const user = { id: aliceId.toString() };

      const visible = [];
      for (const doc of docs) {
        if (await svc.check({ action: "read", path: `/${COL}/${doc._id}`, user, doc })) {
          visible.push(doc.title);
        }
      }

      // Alice sees both of hers; Bob's private post is withheld.
      expect(visible.sort()).toEqual(["alice-draft", "alice-public"]);
    });

    test("with no rules configured, an entire real result set is withheld", async () => {
      const docs = await dbService.getManyDocuments({
        userId: TEST_USER_ID,
        projectCode: PROJECT,
        collectionName: COL,
        query: {},
      });
      const svc = new DbRulesService({});

      const visible = [];
      for (const doc of docs) {
        if (await svc.check({ action: "read", path: `/${COL}/${doc._id}`, user: { id: "x" }, doc })) {
          visible.push(doc.title);
        }
      }

      expect(docs.length).toBe(3);
      expect(visible).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The middleware, over HTTP, against real documents
  // -------------------------------------------------------------------------
  describe("middleware over HTTP with documents loaded from MongoDB", () => {
    function buildApp(rules) {
      const svc = new DbRulesService(rules);
      const app = express();
      app.use(express.json());

      // Stand-in for project_auth.middleware, which is not what is under test.
      app.use("/projects/p1/db", (req, _res, next) => {
        req.project = { code: "p1", userId: TEST_USER_ID };
        req.user = req.get("x-user-id") ? { id: req.get("x-user-id") } : null;
        next();
      });

      // Loads the real document, exactly as documentMiddleware does.
      const loadDoc = async (req, _res, next) => {
        req.doc = await dbService.getDocument({
          userId: TEST_USER_ID,
          projectCode: PROJECT,
          collectionName: req.params.col,
          query: { _id: req.params.id },
        });
        next();
      };

      app.get("/projects/p1/db/:col/:id", loadDoc, svc.middleware(), (req, res) =>
        res.status(200).json({ title: req.doc.title }),
      );
      app.post("/projects/p1/db/:col", svc.middleware(), (req, res) =>
        res.status(200).json({ ok: true }),
      );

      return app;
    }

    test("an owner is served the real document and a stranger gets 403", async () => {
      const app = buildApp({ [`/${COL}`]: { read: "doc.ownerId == user.id" } });

      const owner = await request(app)
        .get(`/projects/p1/db/${COL}/${bobPost._id}`)
        .set("x-user-id", bobId.toString());
      expect(owner.status).toBe(200);
      expect(owner.body.title).toBe("bob-private");

      const stranger = await request(app)
        .get(`/projects/p1/db/${COL}/${bobPost._id}`)
        .set("x-user-id", aliceId.toString());
      expect(stranger.status).toBe(403);
      expect(stranger.body.error).toMatch(/Access denied/);
    });

    test("an unauthenticated request is refused by an ownership rule", async () => {
      const app = buildApp({ [`/${COL}`]: { read: "doc.ownerId == user.id" } });

      const res = await request(app).get(`/projects/p1/db/${COL}/${alicePost._id}`);
      expect(res.status).toBe(403);
    });

    test("a collection-level read with no rules is refused", async () => {
      const res = await request(buildApp({})).post(`/projects/p1/db/${COL}`).send({ query: {} });
      expect(res.status).toBe(403);
    });

    test("a collection-level read is allowed once a rule opts in", async () => {
      const res = await request(buildApp({ [`/${COL}`]: { read: true } }))
        .post(`/projects/p1/db/${COL}`)
        .send({ query: {} });
      expect(res.status).toBe(200);
    });

    test("a public/private rule serves the public document and withholds the private one", async () => {
      const app = buildApp({ [`/${COL}`]: { read: "doc.isPublic == true" } });

      expect((await request(app).get(`/projects/p1/db/${COL}/${alicePost._id}`)).status).toBe(200);
      expect((await request(app).get(`/projects/p1/db/${COL}/${bobPost._id}`)).status).toBe(403);
    });
  });
});
