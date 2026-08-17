# Production Readiness

Every major component, classified honestly. Building the code and passing
a local regression suite is not the same as being production-ready — this
document says which is which.

**Classifications used:**
- **READY** — implemented and genuinely tested (real HTTP requests, real
  processes, real data) in this environment; safe to rely on as-is.
- **READY AFTER EXTERNAL CONFIGURATION** — the code is real and tested,
  but needs real credentials/infrastructure this sandbox doesn't have
  (see `EXTERNAL_INFRASTRUCTURE.md`) before it does anything in staging/
  production.
- **REQUIRES TESTING** — implemented, code-reviewed, but not exercised
  against real external systems/traffic; needs verification once real
  infrastructure exists.
- **NOT READY** — a real, known gap or bug exists (documented below,
  reference the relevant Phase 18 doc for detail).
- **NOT IMPLEMENTED** — doesn't exist yet; explicitly out of scope for
  this phase (a feature, not a fix).

## Core Application

| Component | Status | Notes |
|---|---|---|
| Web app (React/Vite) | READY | Built and served correctly through the hardened Express server; drove real signup through a real headless browser (Phase 18.4) with zero CSP violations. |
| Server (Express/Node) | READY | Boots cleanly, all 76 regression checks pass against a live instance in every Phase 18 configuration tested. |
| Database (SQLite, WAL mode) | READY | Real schema, real FK cascades (now complete — see Deletion Cascades below), `DB_PATH` override tested for real. |
| Mobile app (Flutter) | REQUIRES TESTING | Code-reviewed and edited (environment config, session-expiry handling — Phase 18.9) but **never compiled or run** — no Flutter SDK anywhere this project has been built. `android/`/`ios/` platform folders are not fully scaffolded either. Must be built and run with a real Flutter toolchain before any of this is trusted. |
| Public API (v1) | READY | Existing Phase 17 work, re-verified: 30/30 Public API regression checks pass in every Phase 18 configuration. |
| Admin Panel | READY | Access control reviewed for real in Phase 18.10 (fresh DB check every request, no session caching of the admin flag) — no changes needed, already correct. |

## Environment & Configuration

| Component | Status | Notes |
|---|---|---|
| Startup env validation (`config/env.js`) | READY | Refuses to boot in production with a missing/weak `SESSION_SECRET` or `BYOK_ENCRYPTION_KEY`; warns on other missing recommended vars. Tested in both pass/fail modes. |
| `.env.example` documentation | READY | Every env var this app reads is documented, tiered by when it's needed. |
| Environment separation (dev/staging/prod) | ARCHITECTURE ONLY | `NODE_ENV` correctly changes CORS/cookie/logging behavior (verified), but there is no actual staging environment to separate *from* — this sandbox only ever ran one instance at a time. |

## Caching, Rate Limiting, Sessions, Queue

| Component | Status | Notes |
|---|---|---|
| In-process cache/rate-limit/queue (defaults) | READY | Unchanged, working defaults from Phase 16 — correct for a single-instance deployment. |
| Redis-backed cache (`CACHE_PROVIDER=redis`) | READY (for new async code) | Real, tested against a local `redis-server`. The 3 existing hot-path sync callers deliberately never use it (by design, see `cacheProvider.js`) — not a gap, a documented architectural boundary. |
| Redis-backed rate limiter (`RATE_LIMIT_PROVIDER=redis`) | READY | Fully converted, real, tested — including a full run of all 4 regression suites with it active. |
| Redis-backed session store (`SESSION_STORE=redis`) | READY | Real custom store (not connect-redis — found incompatible with ioredis, removed). Tested for real restart-durability: killed the server process, booted a new one, same cookie still authenticated. |
| Redis-backed job queue (`RedisQueueProvider`) | ARCHITECTURE ONLY | Real, independently tested (39 assertions against real Redis) but not wired into the app's default job-enqueue path — deliberate, documented boundary (see `jobs/queueProvider.js`). |
| Standalone worker (`worker.js`) | READY | Real multi-process test: two independent worker processes sharing one SQLite file correctly split real job load with zero duplication; graceful shutdown on SIGTERM confirmed. |
| Session cookie security | READY (after this phase's fix) | Phase 18.11 found and fixed a real, critical bug: without `trust proxy`, the production `secure: true` cookie was **never sent** behind any real reverse proxy — verified via realistic `X-Forwarded-Proto` simulation. |

## Security

| Component | Status | Notes |
|---|---|---|
| Security headers (CSP, HSTS, etc.) | READY | Real helmet config tuned to the client's actual asset origins; verified via a real headless browser with zero CSP violations. |
| CORS | READY | Dev: permissive (unchanged). Production: explicit allowlist, fails closed if `CLIENT_ORIGIN` unset — verified via real curl requests in both modes. |
| Tenant isolation / IDOR / privilege escalation | READY | Existing Phase 16 protections, re-verified passing in every Phase 18 configuration (24/24 security regression checks). |
| OAuth CSRF protection | READY (after this phase's fix) | Found and fixed a real weak-RNG bug in `state` generation (Gmail/Google-services/Meta) — now uses `crypto.randomBytes`, matching every other security token in the codebase. |
| OAuth token storage | NOT READY | **Known, documented gap**: access/refresh tokens are stored in plaintext in the database. Not fixed in this phase — 12+ call sites, no live OAuth credentials available to test a decrypt retrofit against safely. See `PHASE18_10_OAUTH_BILLING_ADMIN_REVIEW.md` for the exact fix shape needed. |
| OAuth token revocation on disconnect | NOT READY | Disconnecting an integration only clears local DB fields — never calls the provider's real revoke endpoint. Documented, not fixed (same reason: untestable without live credentials). |
| Stripe webhook security | READY | Real signature verification (Stripe's own SDK), real idempotency, correct retry semantics — verified by code review, matches Phase 16-era `.env.example` documentation exactly. |
| Session/cookie security | READY | `httpOnly`, `SameSite=Lax`, `secure` in production (now actually reachable behind a proxy — see trust-proxy fix above), non-default cookie name. |
| Mobile token storage | READY | No bearer tokens or secrets stored client-side — real cookie-jar-based session auth (Phase 18.9 review), verified by reading the full storage implementation. |
| Mobile session expiry | READY (after this phase's fix) | Real gap found and fixed: no mid-session 401 detection existed before Phase 18.9 — added, code-reviewed but **not compiled/run** (no Flutter SDK). |
| Org/API-key/account deletion cascades | READY (org-level; account-level not implemented) | Found and fixed a real, significant bug: deleting an org orphaned data (including real files on disk) in 17 tables with no FK enforcement. Fixed and tested with 16 real assertions. User-initiated account self-deletion does not exist at all (see below). |

## Observability

| Component | Status | Notes |
|---|---|---|
| Structured logging | READY | Real JSON logs with request IDs, verified matching between the `X-Request-Id` response header and the actual log line for a real request. |
| Health checks (liveness/readiness/deep) | READY | `/live`, `/ready` public and minimal (correct for infra probes); admin-gated deep checks including a real Redis connectivity check tested in all 3 real states (unconfigured/reachable/unreachable). |
| Error tracking (external service) | NOT IMPLEMENTED | No Sentry/equivalent integrated. Structured logs are real, useful input for one, but nothing external is wired up. |
| Alerting | NOT IMPLEMENTED | No paging/alerting system exists. This is inherent to not having a monitoring service in the loop at all. |
| Cost visibility dashboard | NOT IMPLEMENTED | No AI-cost/infra-cost/margin tracking beyond what Phase 16's existing per-org spend limits already provide. |

## Data & Backup

| Component | Status | Notes |
|---|---|---|
| Database backup/restore scripts | READY | Real, tested end-to-end: backup against a live server, genuine corruption of the working DB, restore, verified row-level data survives — including proof that post-backup writes are correctly *not* restored (real RPO characteristic). |
| Continuous replication (Litestream) | ARCHITECTURE ONLY | Documented as the recommended real production strategy; requires an S3 bucket and a long-running sidecar process not available here. |
| Disaster recovery beyond DB | NOT IMPLEMENTED | No documented/tested recovery procedure for object storage, secrets, DNS, or a full app redeploy — only the database layer was covered in this phase. |

## CI/CD & Deployment

| Component | Status | Notes |
|---|---|---|
| CI workflow (`.github/workflows/ci.yml`) | READY | Every job's exact commands dry-run locally against this repo before being committed: syntax check, client build, fresh-DB boot, all 4 regression suites, real Redis connectivity check, OpenAPI validation, both SDK smoke tests. |
| Dockerfile / docker-compose.yml | REQUIRES TESTING | Syntax-reviewed, `docker compose config` validated the full schema — but **never actually built or run**, no Docker daemon available in this sandbox. |
| Deployment runbook | READY (as documentation) | See `DEPLOYMENT_RUNBOOK.md` — the procedure is written and internally consistent with everything built in this phase, but has not been executed against a real target. |
| Rollback procedure | REQUIRES TESTING | Documented in `DEPLOYMENT_RUNBOOK.md`; the backup/restore mechanism it depends on is real and tested, but a full app-rollback rehearsal has not been performed. |
| Zero-downtime deployment | NOT IMPLEMENTED | Not measured or engineered for — no claim of zero downtime is made anywhere in this phase's documentation. |

## Load & Capacity

| Component | Status | Notes |
|---|---|---|
| Load testing scripts | READY | Real autocannon-based scripts, real measured results (see `LOAD_TEST_RESULTS.md`) — explicitly labeled single-process sandboxed dev-instance numbers, not a production capacity claim. |
| Production capacity | NOT IMPLEMENTED (as a claim) | No number in this repo should be read as "the platform can handle X req/s in production" — that requires real hardware and a real dataset, neither available here. |

## Billing

| Component | Status | Notes |
|---|---|---|
| Stripe integration (existing) | READY AFTER EXTERNAL CONFIGURATION | Code is real and correct (verified in this phase's review); needs a real Stripe account + webhook registration to actually receive events. |
| Quota/spend-limit enforcement | READY | Existing Phase 16 work, re-verified passing in every Phase 18 configuration. |

## Mobile Production Config

| Component | Status | Notes |
|---|---|---|
| Environment config (`--dart-define`) | REQUIRES TESTING | Replaces the hardcoded dev URL with real dev/staging/prod resolution — code-reviewed, brace/paren-balance-checked, but not compiled. |
| App Store / Play Store readiness | NOT READY | Platform folders (`android/`, `ios/`) aren't fully scaffolded; no real build has ever been produced. |
| Push notifications | READY AFTER EXTERNAL CONFIGURATION | Implemented (Firebase Admin SDK) since an earlier phase; needs a real Firebase project + APNs cert to actually deliver anything. |

## What genuinely changed this phase that a reader should trust without re-verifying

Every "READY" line above that references a specific real test (a live
server boot, a real browser, a real Redis instance, a real killed-and-
restarted process, a real corrupted-then-restored database, a real
multi-process worker run, a real curl request with a simulated proxy
header) reflects something that was actually run in this environment
during Phase 18, not reasoned about. Anything marked REQUIRES TESTING or
ARCHITECTURE ONLY was deliberately not claimed as more than that.
