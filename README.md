# FlexDocs Community API (single-admin)

A self-hosted Backend-as-a-Service: auth, a rules-guarded document database, file
storage, and realtime sockets — packaged as a **single-admin** edition. There is no
public dashboard signup; exactly one administrator runs the instance and can create
any number of **projects** (each an isolated app backend with its own end-user auth,
database, and storage).

This repository is **just the API** and is designed to be installed on its own. For a
one-command full stack (nginx + this API + web dashboard + MongoDB), use the separate
installer instead — see [Full stack](#full-stack-installer).

## Requirements

- Node.js 18+
- A reachable MongoDB instance (local, Docker, or hosted/Atlas)

## Manual install

```bash
git clone https://github.com/khalid-arafa/flexdocs-community-api.git
cd flexdocs-community-api
npm install

cp .env.example .env
# then edit .env (see below)

npm start          # or: npm run dev  (nodemon, auto-reload)
```

### Configure `.env`

Required:

| Var | What |
|---|---|
| `JWT_SECRET` | random secret for signing JWTs |
| `ENCRYPTION_KEY` | random key (distinct from `JWT_SECRET`) |
| `MONGODB_URI` | e.g. `mongodb://user:pass@localhost:27017/?authSource=admin` |
| `SETUP_TOKEN` | random token required to complete the first-run `/setup` wizard |

Generate strong values:

```bash
echo "JWT_SECRET=\"$(openssl rand -base64 32)\""
echo "ENCRYPTION_KEY=\"$(openssl rand -base64 32)\""
echo "SETUP_TOKEN=\"$(openssl rand -hex 24)\""
```

Optional: `ALLOWED_ORIGINS`, `RATE_LIMIT_*`, email (`RESEND_API_KEY` or `SMTP_*`),
`APP_NAME`/`FROM_*`. See [.env.example](.env.example).

The API listens on `PORT` (default `3000`).

## First-run setup (create the single admin)

On a fresh database no admin exists, so the API serves a one-time, token-gated wizard:

1. Open `http://localhost:3000/setup?token=<SETUP_TOKEN>`
2. Create the administrator account.

Endpoints:

- `GET /setup/status` → `{ "needsSetup": true|false }`
- `GET /setup` → the admin-creation page (needs the `?token=`)
- `POST /setup` → creates the sole admin (`roles: ["admin"]`)

The wizard is **token-gated** so a stranger can't claim the admin during the install
window, and it **self-locks** once an admin exists (further calls return `403`). Public
system signup (`POST /register`) does not exist in this edition.

**Headless alternative:** set `ADMIN_EMAIL` and `ADMIN_PASS` in `.env` and the admin is
seeded at startup instead (the wizard then reports "already configured").

## Email (SMTP / Resend)

Email is **optional** and configurable at runtime — no restart needed:

- During first-run **/setup**, you can optionally enter SMTP or Resend settings.
- Later, an admin can view/update them via the API (the dashboard builds the UI):
  - `GET /settings/email` — current config (secrets masked)
  - `PUT /settings/email` — update (a secret is only changed when a new value is sent)
  - `POST /settings/email/test` — send a test email
- If nothing is stored, the service falls back to env vars (`RESEND_API_KEY` or
  `SMTP_*` + `FROM_*`).

Stored secrets (SMTP password, Resend key) are **encrypted at rest** with
`ENCRYPTION_KEY` and never returned by `GET` (shown as `********`).

## Run with Docker (single container)

This repo ships a `Dockerfile` (dev) and `Dockerfile.prod` (slim). Bring your own MongoDB.

```bash
docker build -f Dockerfile.prod -t flexdocs-api .
docker run --rm -p 3000:3000 --env-file .env flexdocs-api
```

## Full stack installer

To run the whole platform (Nginx reverse proxy + this API + the web dashboard +
MongoDB) with one command, use the standalone installer (`setup.sh`). It clones this
API and the web dashboard, generates secrets, and starts everything via Docker Compose,
then prints the first-run `/setup?token=…` link. The installer lives outside this repo
so the API stays installable on its own.

## What stays multi-tenant

Only **system/dashboard** signup is locked to one admin. The **projects** feature is
unchanged: the admin creates projects, and each project keeps its own end-user auth
under `/projects/:code/auth/*`, its own database, and storage.

## Tests

```bash
npm test
```

## Notes
- Secrets live only in `.env` (gitignored). Never commit it.
- `GET /health` returns `{ "status": "ok", "db": "connected" }` when MongoDB is reachable.
