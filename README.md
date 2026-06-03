# FlexDocs Community API (single-admin)

A self-hosted Backend-as-a-Service: auth, a rules-guarded document database, file
storage, and realtime sockets — packaged as a **single-admin** edition. There is no
public dashboard signup; exactly one administrator runs the instance and can create
any number of **projects** (each an isolated app backend with its own end-user auth,
database, and storage).

## Quick start

```bash
git clone https://github.com/khalid-arafa/flexdocs-community-api.git
cd flexdocs-community-api
./setup.sh
```

`setup.sh` checks Docker, clones the web dashboard into `./web`, generates secrets
into `./.env`, and starts the full stack (nginx + api + web + mongodb). When it
finishes it prints a **first-run setup link**:

```
http://api.localhost/setup?token=<SETUP_TOKEN>
```

Open it once to create your administrator account, then sign in at the dashboard.

> `api.localhost` / `admin.localhost` resolve to `127.0.0.1` on most systems. If
> yours doesn't, add them to `/etc/hosts`:
> `127.0.0.1 api.localhost admin.localhost`

### Prerequisites
- Docker + Docker Compose
- git

## First-run setup (how the single admin is created)

On a fresh install no admin exists, so the API serves a one-time wizard:

- `GET /setup/status` → `{ "needsSetup": true|false }`
- `GET /setup` → the admin-creation page (requires the `?token=` from `./.env`)
- `POST /setup` → creates the sole admin (`roles: ["admin"]`)

The wizard is **token-gated** (`SETUP_TOKEN` in `./.env`) so a stranger can't claim
the admin during the install window, and it **self-locks** once an admin exists
(further calls return `403`). Public system signup (`POST /register`) has been removed.

**Headless alternative:** set `ADMIN_EMAIL` and `ADMIN_PASS` in `./.env` and the admin
is seeded at startup instead (the wizard then reports "already configured").

## URLs

| Service | URL |
|---|---|
| Dashboard | http://admin.localhost |
| API | http://api.localhost |
| API health | http://api.localhost/health |
| First-run setup | http://api.localhost/setup?token=… |

## What stays multi-tenant

Only **system/dashboard** signup is locked to one admin. The **projects** feature is
unchanged: the admin creates projects, and each project keeps its own end-user auth
under `/projects/:code/auth/*` (register/login/etc.), its own database, and storage.

## Managing the stack

```bash
docker compose ps          # status
docker compose logs -f     # logs
docker compose down        # stop
docker compose up -d        # start
docker compose up -d --build  # rebuild
```

## Development / tests

```bash
npm install
npm test          # jest
npm run dev       # nodemon (expects a reachable MongoDB via MONGODB_URI)
```

## Notes
- Secrets live only in `./.env` (gitignored). The committed `docker-compose.yml` and
  `nginx/` contain no secrets (Compose interpolates `${MONGO_USER}`/`${MONGO_PASS}`
  from `./.env`).
- The web dashboard is a separate repo cloned by `setup.sh`. Its signup page is not
  used in this edition (there is no system signup endpoint to back it).
