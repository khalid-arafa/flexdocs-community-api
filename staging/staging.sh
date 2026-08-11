#!/usr/bin/env bash
#
# Phase 0 — a FlexDocs environment that is not production.
#
#   ./staging.sh up      start staging Mongo (single-node replica set)
#   ./staging.sh seed    create the admin + a staging project, print its creds
#   ./staging.sh env     print the env lines to run the api against staging
#   ./staging.sh api     run the api against staging in this terminal
#   ./staging.sh status  what is running, and which project codes exist
#   ./staging.sh down    stop staging (data survives)
#   ./staging.sh destroy stop staging AND delete its data volume
#
# Why this exists: `npm run dev` points at the same FlexDocs project as
# production, so every task that needs deliberate failure testing — rule
# denials, auth expiry, realtime disconnects, data migrations — has had
# nowhere safe to run. This is that place.
#
# Nothing here can reach production: the port, container name, database and
# volume are all staging-specific, and the api is launched with an explicit
# MONGODB_URI that overrides api/.env (dotenv does not overwrite variables
# already present in the environment).

set -euo pipefail

STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$STAGING_DIR/.." && pwd)"
COMPOSE_FILE="$STAGING_DIR/docker-compose.staging.yml"

STAGING_PORT=27019
STAGING_URI="mongodb://127.0.0.1:${STAGING_PORT}/?replicaSet=rs-staging&directConnection=true"
STAGING_API_PORT="${STAGING_API_PORT:-3100}"
PROJECT_CODE="${STAGING_PROJECT_CODE:-staging}"

# Fixed, obviously-fake secrets. Staging holds nothing worth protecting, and
# hardcoding them keeps tokens stable across restarts so a saved request keeps
# working. Never reuse these anywhere real.
export JWT_SECRET="${JWT_SECRET:-staging-jwt-secret-not-for-production}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-staging-encryption-key-not-for-prod}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

mongo_eval() {
  docker exec flexdocs-mongo-staging mongosh --quiet --eval "$1"
}

require_up() {
  docker ps --format '{{.Names}}' | grep -q '^flexdocs-mongo-staging$' \
    || die "staging Mongo is not running — run './staging.sh up' first"
}

# Refuses to run if the URI is not the staging one. Cheap insurance against a
# copy-pasted command reaching production.
assert_staging_uri() {
  case "${1:-}" in
    *"${STAGING_PORT}"*) : ;;
    *) die "refusing to run: MONGODB_URI is not the staging instance" ;;
  esac
}

cmd_up() {
  bold "Starting staging MongoDB (single-node replica set, port ${STAGING_PORT})"
  compose up -d
  info "waiting for a PRIMARY to be elected..."
  for _ in $(seq 1 40); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' flexdocs-mongo-staging 2>/dev/null)" = "healthy" ]; then
      bold "Staging Mongo is up."
      mongo_eval 'JSON.stringify({setName: db.hello().setName, primary: db.hello().isWritablePrimary})'
      info "Change streams are available here, so realtimeChangeStreams can be rehearsed."
      return 0
    fi
    sleep 2
  done
  die "Mongo did not become healthy — check 'docker logs flexdocs-mongo-staging'"
}

cmd_env() {
  cat <<EOF
export MONGODB_URI='${STAGING_URI}'
export JWT_SECRET='${JWT_SECRET}'
export ENCRYPTION_KEY='${ENCRYPTION_KEY}'
export PORT='${STAGING_API_PORT}'
export NODE_ENV='development'
EOF
}

cmd_api() {
  require_up
  assert_staging_uri "$STAGING_URI"
  bold "Starting the api against STAGING on port ${STAGING_API_PORT}"
  info "MONGODB_URI=${STAGING_URI}"
  info "This overrides api/.env — dotenv never overwrites an existing env var."
  cd "$API_DIR"
  MONGODB_URI="$STAGING_URI" PORT="$STAGING_API_PORT" NODE_ENV=development \
    npm run dev
}

cmd_seed() {
  require_up
  bold "Seeding staging"

  # Written straight to Mongo rather than through the setup wizard: the wizard
  # self-locks after first run and needs a live server, whereas this has to be
  # idempotent and runnable before the api ever starts.
  #
  # `userId` MUST be the owning admin's ObjectId, never the literal "_system".
  # core/client.js routes a project to a database with
  #   userId === systemDatabaseName ? systemDatabaseName : projectCode
  # so a project owned by "_system" reads and writes the SYSTEM database — its
  # accounts land in _system._users alongside the real admin, and none of its
  # data goes to its own database at all. A staging project shaped differently
  # from a real one is worse than no staging project, because it produces
  # confidently wrong answers.
  local out
  out=$(mongo_eval "
    const sys = db.getSiblingDB('_system');
    const code = '${PROJECT_CODE}';

    const admin = sys.getCollection('_users').findOne({}, { sort: { createdAt: 1 } });
    if (!admin) {
      print('NO_ADMIN');
      quit(0);
    }

    let project = sys.projects.findOne({ code });
    if (!project) {
      sys.projects.insertOne({
        name: 'Staging',
        code,
        description: 'Phase 0 staging project — safe to break',
        isPublic: true,
        isActive: true,
        userId: admin._id,
        credentials: [],
        dbRules: {},
        authRules: {},
        storageRules: {},
        createdAt: new Date(),
      });
      print('created project ' + code);
    } else if (String(project.userId) !== String(admin._id)) {
      sys.projects.updateOne({ code }, { \$set: { userId: admin._id } });
      print('repaired project ' + code + ': userId now ' + admin._id);
    } else {
      print('project ' + code + ' already exists');
    }
    print('owner: ' + admin._id + ' (' + admin.email + ')');
    print('projects: ' + sys.projects.countDocuments());
  ")

  if echo "$out" | grep -q NO_ADMIN; then
    die "no system admin exists yet — start the api once with ADMIN_EMAIL/ADMIN_PASS set:
    ADMIN_EMAIL=admin@staging.test ADMIN_PASS='StagingAdmin1!' ./staging.sh api
  then re-run './staging.sh seed'"
  fi
  echo "$out" | sed 's/^/  /'

  cat <<EOF

$(bold "Staging project ready")
  code      : ${PROJECT_CODE}
  isPublic  : true  (no project token needed over REST)
  dbRules   : {}    (default-deny — add rules to test denials)

$(bold "Point a client at it")
  baseUrl     http://127.0.0.1:${STAGING_API_PORT}
  projectCode ${PROJECT_CODE}

$(bold "Rehearse the risky flags here before production")
  realtimeChangeStreams  change streams work — this IS a replica set
  authTokenExpiry        e.g. "5m" to watch a session lapse in a minute
  realtimePerDocCheck    per-document rule re-check on realtime push
  manualIndexes          turn auto-indexing off
  storageRealtimeCheck   storage-rule guard on watch-buckets

  Set them with:
    curl -X PUT http://127.0.0.1:${STAGING_API_PORT}/projects/${PROJECT_CODE} \\
      -H 'Content-Type: application/json' \\
      -d '{"authTokenExpiry":"5m"}'
EOF
}

cmd_status() {
  if docker ps --format '{{.Names}}' | grep -q '^flexdocs-mongo-staging$'; then
    bold "Staging Mongo: running on port ${STAGING_PORT}"
    mongo_eval 'JSON.stringify({setName: db.hello().setName, primary: db.hello().isWritablePrimary})' | sed 's/^/  /'
    bold "Projects"
    mongo_eval "db.getSiblingDB('_system').projects.find({}, {code:1, name:1, _id:0}).toArray()" | sed 's/^/  /'
  else
    bold "Staging Mongo: not running"
  fi
}

cmd_down() {
  bold "Stopping staging (data volume kept)"
  compose down
}

cmd_destroy() {
  bold "Stopping staging and DELETING its data"
  compose down -v
  info "volume flexdocs-staging-mongo-data removed"
}

case "${1:-}" in
  up)      cmd_up ;;
  seed)    cmd_seed ;;
  env)     cmd_env ;;
  api)     cmd_api ;;
  status)  cmd_status ;;
  down)    cmd_down ;;
  destroy) cmd_destroy ;;
  *)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
