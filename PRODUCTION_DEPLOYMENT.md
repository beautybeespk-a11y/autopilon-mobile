# Production Deployment (Phase 20)

How this application is actually deployed and operated on a real VPS —
the architecture, every script, the CI/CD pipeline, and how updates/
rollback work. See `VPS_SETUP.md` for the initial setup steps and
`BACKUP_RUNBOOK.md` for backup/restore specifics.

## Architecture

```
                         INTERNET
                            │
                            ▼
                       YOUR DOMAIN
                            │
                            ▼
                        TRAEFIK  (only public container — 80/443)
                    Let's Encrypt · HTTP→HTTPS
                            │
                    ┌───────┴────────┐
                    ▼                ▼
                 WEB/API          (HTTPS termination
              (Express, :4000      happens here)
               internal only)
                    │
          ┌─────────┼─────────┐
          ▼         ▼          ▼
       SQLite     Redis      Worker
      (WAL mode, (cache/    (server/worker.js,
       app_data   rate-limit/ shares the same
       volume)    session,    SQLite file via
                  internal    WAL mode)
                  only)
```

This is the actual repository architecture (`docker-compose.yml` +
`docker-compose.prod.yml`), not a hypothetical one. Every piece except
Traefik already existed and was tested in Phases 16-19; Traefik is new in
Phase 20 — it did not exist anywhere in this repo before, added
specifically to provide the real domain + HTTPS entrypoint Phase 19
identified as the one missing production blocker (see `PHASE19_NOTES.md`
§2/§7).

**Four containers**, defined together, meant to run on one host:

| Container | Image | Public? | What it does |
|---|---|---|---|
| `traefik` | `traefik:v3.1` | Yes — the only one (80/443) | TLS termination, Let's Encrypt, routes `Host(your-domain)` traffic to `app` |
| `app` | built from this repo's `Dockerfile` | No (reached only via Traefik, same Docker network) | Express API + built React client |
| `worker` | same image as `app` | No | `node worker.js` — claims jobs from the shared SQLite `jobs` table, no HTTP server at all |
| `redis` | `redis:7-alpine` | No (internal Docker network only) | Cache / rate-limit / session store |

Two Docker networks: `web` (Traefik + `app` only — the one thing that
needs to be reachable from the internet) and `internal` (`app` + `worker`
+ `redis` — never touches the host's public interface). Redis and the
app's own port are never published to the host at all; confirmed via a
real `docker compose config` resolution during this phase (see
`docker-compose.prod.yml`'s own comments).

## Why SQLite (not a separate database container)

Unchanged architecture from Phases 16-19, verified again in Phase 19: the
database is SQLite in WAL mode, an embedded file on the `app_data` Docker
volume, shared safely between the `app` and `worker` containers because
they're on the same host/same disk (WAL mode's cross-process safety
requires that). No separate database service exists or is needed at this
scale — see `PHASE19_NOTES.md`'s SQLite-vs-PostgreSQL analysis for
exactly when that would change (in short: when you need workers/app
instances on more than one physical machine, which is a topology
requirement, not a raw performance one).

## Why images are built by GitHub Actions, not on the VPS

`.github/workflows/build-and-push.yml` builds the existing `Dockerfile`
(unchanged — same multi-stage server+client build that already existed)
and pushes it to GitHub Container Registry (`ghcr.io`) after the real CI
workflow (`ci.yml` — syntax checks, all 20 regression suites, OpenAPI
validation, both SDK smoke tests) has actually passed on `main`. The VPS
then only ever runs `docker compose pull` — a `docker pull`, not a build.

This matters concretely on a 2-vCPU VPS: building this app on-box means
`npm ci` for both server and client, a real Vite production build (1,620
modules, per this repo's own build logs), and compiling
`better-sqlite3`'s native binding — real CPU/RAM work that a small VPS
would rather not do on every deploy. `install-production.sh` and
`deploy.sh` both fall back to building on-box automatically if the
pre-built image isn't reachable (e.g. before the GHCR package is made
public — see "SECRETS REQUIRED" below) — this fallback is real and uses
the exact same, already-tested `Dockerfile`/`docker-compose.yml` build
path, just slower.

## The scripts

All at the repository root, all executable, all safe to re-run:

| Script | What it does |
|---|---|
| `bootstrap-production.sh` | Thin `curl \| bash` entrypoint — clones the repo, hands off to `install-production.sh`. |
| `install-production.sh` | The real installer — Ubuntu prep, Docker, firewall, `.env`, first boot, health checks. Idempotent. |
| `deploy.sh [tag]` | Pulls a new image (or `IMAGE_TAG` from `.env` if none given), restarts containers, preserves all volumes, health-checks, records the previous image for rollback. |
| `rollback.sh [--yes]` | Reverts to the image `deploy.sh` most recently replaced. Preserves all data — only ever changes which code is running. |
| `backup.sh [--encrypt]` | Real, compressed (optionally AES-256-encrypted) backup of the database + uploaded files, with retention pruning and integrity verification. |
| `restore.sh <file> [--yes]` | Restores a backup produced by `backup.sh` — stops app/worker, saves a safety copy of current data first, restores, restarts, health-checks. |
| `status.sh` | One-shot dashboard: containers, health, Redis memory, disk, RAM, TLS cert expiry, most recent backup, currently-deployed image. |
| `logs.sh [service] [-f]` | Tails (optionally follows) a service's real logs. |
| `_common.sh` | Shared helper functions (not an entrypoint — sourced by the others, exists to avoid duplicating the health-check/prompt logic six times). |

## Future updates: GitHub → CI → Deploy → VPS

```
   git push to main
          │
          ▼
   CI (ci.yml) — syntax, 20 regression suites, OpenAPI, both SDKs
          │  (only on success)
          ▼
   build-and-push.yml — builds Dockerfile, pushes to ghcr.io
          │
          ▼
   (on the VPS, whenever you're ready) ./deploy.sh
          │
          ▼
   pulls the new image, restarts containers, preserves all volumes,
   health-checks, records the previous image for rollback
```

`./deploy.sh` is a **pull-based** deploy — you (or a cron job, or a
webhook you set up) decide when the VPS actually updates, rather than
every merge to `main` immediately going live. This is the deliberately
safer default (see `build-and-push.yml`'s own comments on the disabled-
by-default push-deploy job for the alternative, if you want fully
automatic deploys later — it needs two extra GitHub secrets this
installer does not create for you, since they'd need real SSH access to
your VPS this session has never had).

No separate migration step exists or is needed: `server/db.js` applies
any new additive schema changes (PRAGMA-guarded `ALTER TABLE ADD COLUMN`)
automatically the moment the new containers boot — confirmed by source
audit (zero `DROP TABLE`/`DROP COLUMN`/`RENAME` statements anywhere) and
by a real test built in Phase 19 (`test:db-migration`) that boots current
code against a database shaped like the oldest pre-migration schema with
real data in it and confirms zero data loss.

## Rollback

`./rollback.sh` reverts to whatever image `deploy.sh` most recently
replaced — tracked in `.deploy-state/previous-image`, updated on every
deploy. It:

1. Shows you the current vs. target image and asks for confirmation
   (skip with `--yes`).
2. Updates `IMAGE_TAG` in `.env` to the previous value.
3. Pulls that image and restarts `app`/`worker`.
4. Runs the same real health checks as every other script.

**Everything is preserved** — users, database, agents, projects,
integrations, settings: rollback only ever changes which container image
is running, never touches the `app_data`/`app_uploads`/`redis_data`/
`traefik_letsencrypt` volumes. Rolling back to an older version against a
database a newer version already wrote additive columns to is safe by
construction (see "Why SQLite" above and `PRODUCTION_READINESS.md`'s
"Migration rollback strategy" entry) — older code simply ignores columns
it doesn't recognize.

Running `rollback.sh` twice in a row rolls forward again (it swaps
"current" and "previous" in its own state file) rather than being a
no-op the second time.

## Security posture

- **Firewall**: only 22/80/443 reachable from the internet (`ufw`,
  configured with an explicit anti-lockout check before enabling).
- **Redis**: no host port published at all — reachable only over the
  internal Docker network, by service name.
- **App's own port (4000)**: no host port published — reachable only
  through Traefik.
- **Docker's management socket**: mounted **read-only** into Traefik
  (the only container that needs it, to discover routes) — nothing else
  touches it.
- **Secrets**: live only in `/opt/autopilon/.env` (mode 600, root-owned,
  gitignored) and, for registry auth if you choose the PAT path, in
  Docker's own credential store — never in a git commit, never baked into
  the Docker image (env vars are injected at container start, not build
  time), never in frontend JavaScript (the client only ever talks to
  this app's own `/api/*`, which never echoes a secret back), never
  logged (see `config/logger.js`'s redaction safety net, Phase 18.5).
- **HTTPS**: enforced — Traefik redirects all HTTP to HTTPS
  (`permanent=true`, a real 301) before any request reaches the app.
- **Reverse-proxy trust**: the app's existing `trust proxy` setting
  (`app.set("trust proxy", 1)`, Phase 18.11) expects exactly one trusted
  hop in front of it — Traefik sitting directly in front, as the *only*
  hop, is exactly that topology, and is the same configuration Phase
  18.1's reverse-proxy regression suite already tested (`proxy` mode).
- **Rate limiting**: unchanged, existing app-level rate limiting (Phase
  16/18/19 — now including the Phase 19 fix so a Redis outage fails open
  instead of taking down all API traffic). No second, competing rate
  limiter was added at the Traefik layer — that would risk conflicting
  or confusing 429 behavior with the app's own, more tenant-aware limits.
- **No Traefik dashboard/API exposed** — one less public attack surface;
  not needed for this deployment to function.

## Monitoring

Lightweight, on purpose (Phase 20 explicitly asked not to install
"expensive monitoring infrastructure"):

- `./status.sh` — containers, health, Redis memory, disk, RAM, cert
  expiry, latest backup, currently-deployed image, all in one shot.
- `./logs.sh [service] [-f]` — real container logs.
- Structured JSON logging already exists inside the app itself (Phase
  18.5) — every log line has a request ID; a global error handler (Phase
  19) means unhandled errors are always logged server-side even when the
  client only sees a generic message.

External uptime/error-tracking (Sentry, Datadog, a status page) is not
installed — see `EXTERNAL_INFRASTRUCTURE.md`'s Monitoring section; this
remains a real, documented gap (P1 in `LAUNCH_BLOCKERS.md`), not silently
assumed to already exist.

## Mobile apps

Android/iOS builds use `--dart-define=API_BASE_URL=https://your-domain.com/api`
at build time and talk to this exact same deployment over the same REST
API the web client uses — confirmed by reading
`autopilon_mobile/lib/core/config/app_config.dart` directly: there is no
separate backend, no separate hosting, and no code change needed on
either side. This deployment IS the mobile backend, the moment HTTPS is
live. (A real Flutter build has never been produced in any sandbox this
project has used — see `LAUNCH_BLOCKERS.md` — but that's a Flutter-
toolchain gap, not a backend-hosting gap.)

## Secrets required (names only — never share the values in chat)

Prompted for by `install-production.sh`, or add later by editing `.env` +
`./deploy.sh`:

- `SESSION_SECRET`, `BYOK_ENCRYPTION_KEY` — auto-generated by the
  installer (`openssl rand -hex 32`), never prompted for.
- `DOMAIN_NAME`, `ACME_EMAIL`, `PLATFORM_ADMIN_EMAIL` — not secrets, but
  required.
- One of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` —
  required.
- Optional: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `META_APP_ID`,
  `META_APP_SECRET` — skippable, add later.
- Optional, only if the GHCR package is kept private: a GitHub Personal
  Access Token (classic, `read:packages` scope only) for `docker login
  ghcr.io` on the VPS. **Recommended instead**: make the package public
  once, in GitHub's UI (Package settings → Change visibility → Public) —
  then no VPS-side credential is needed at all, since the source
  repository is already public.
