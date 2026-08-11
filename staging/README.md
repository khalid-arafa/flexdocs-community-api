# Staging — Phase 0

A FlexDocs environment that is **not production**.

Until this existed, `npm run dev` pointed at the same FlexDocs project as
production. That is why every risky item in the remediation plan stayed
deferred: verifying a rule denial, an auth expiry, a realtime disconnect or a
data migration meant deliberately breaking live data. This is the place to do
that instead.

## Quick start

```bash
cd api/staging

./staging.sh up                                   # start Mongo (replica set)
ADMIN_EMAIL=admin@staging.test ADMIN_PASS='StagingAdmin1!' ./staging.sh api &
./staging.sh seed                                 # create the staging project
```

Then point a client at `http://127.0.0.1:3100`, project code `staging`.

| Command | Does |
|---|---|
| `./staging.sh up` | Start staging Mongo and wait for a PRIMARY |
| `./staging.sh seed` | Create/repair the staging project (idempotent) |
| `./staging.sh api` | Run the api against staging, in this terminal |
| `./staging.sh env` | Print the env lines, to run the api yourself |
| `./staging.sh status` | What's running, and which projects exist |
| `./staging.sh down` | Stop; data survives |
| `./staging.sh destroy` | Stop and delete the data volume |

## Why a replica set

Production runs one, and change streams — `project.realtimeChangeStreams` —
exist only there. A standalone staging Mongo could not rehearse the single
feature most in need of a rehearsal. The compose healthcheck initiates the set
on first start and reports healthy only once a PRIMARY is elected, because the
api's change-stream capability probe runs at startup and would otherwise race
the election.

## It cannot reach production

Four independent guards:

- a non-default port (`27019`), container name, database and volume
- no shared credentials — staging uses fixed, obviously-fake secrets
- `staging.sh api` passes `MONGODB_URI` explicitly, and dotenv never overwrites
  a variable already present in the environment, so `api/.env` cannot win
- `assert_staging_uri` refuses to start if the URI isn't the staging one

## What to rehearse here

Every per-project flag, before touching a production project:

| Flag | Rehearse |
|---|---|
| `realtimeChangeStreams` | Events for writes made outside the API; that a delete without pre-images carries only `_id` |
| `authTokenExpiry` | Set `"5m"` and watch a session lapse in a minute instead of waiting a day |
| `realtimePerDocCheck` | That your `dbRules` actually admit the documents you expect on push |
| `manualIndexes` | That the queries you care about still have indexes after auto-creation is off |
| `storageRealtimeCheck` | That `watch-buckets` still delivers to the clients that should see it |

```bash
curl -X PUT http://127.0.0.1:3100/my/projects/staging \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"authTokenExpiry":"5m"}'
```

## One trap worth knowing

A project's `userId` must be the owning admin's ObjectId, never the literal
string `"_system"`. `core/client.js` picks a database with

```js
userId === systemDatabaseName ? systemDatabaseName : projectCode
```

so a project owned by `"_system"` reads and writes the **system** database —
its accounts land in `_system._users` next to the real admin, and nothing goes
to its own database at all. The first version of this script got that wrong,
and the resulting environment answered a revocation test incorrectly: a
staging environment shaped differently from production is worse than none,
because it gives confidently wrong answers. `seed` now derives the owner from
the real admin and repairs a project that has it wrong.
