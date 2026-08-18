# Staging Environment Checklist

A single checklist to run through when standing up a real staging
environment. Updated in Phase 19 with real staging-verification work
(a genuine GitHub Actions CI run, real Redis-outage/worker-crash chaos
testing, a real backup/restore/clean-checkout-deployment cycle) layered
on top of Phase 16-18.2's sandbox testing.

**Status values** (exactly the five the Phase 19 spec requires):
- **PASS** — genuinely exercised in this environment (or, for a few
  items this phase, against a real external service like GitHub
  Actions), safe to trust as-is.
- **FAIL** — a real, known gap. Doesn't block a first staging boot, but
  shouldn't be forgotten.
- **BLOCKED** — cannot be verified from this sandbox at all right now,
  for a reason more specific than "needs infrastructure" (e.g. an
  organizational network policy).
- **NOT APPLICABLE** — genuinely doesn't apply to this deployment shape.
- **EXTERNAL SETUP REQUIRED** — real, working code; needs a real
  credential/account/service this sandbox doesn't have before it can be
  exercised for real. See `EXTERNAL_INFRASTRUCTURE.md` for exact steps.

| Area | Item | Status | Notes |
|---|---|---|---|
| **Application** | Server boots cleanly | PASS | Verified in dev, production-mode, and combined-with-Redis configurations, including a real clean-checkout-to-running cycle in Phase 19. |
| | Client builds and serves correctly | PASS | Real headless-browser test, zero CSP violations, screenshot-verified rendering; client build re-verified from a clean checkout in Phase 19. |
| | Env validation refuses unsafe production boot | PASS | Tested both failure and success paths. |
| | `trust proxy` configured for a real reverse proxy | PASS (fixed Phase 18.11) | Was a real, silent login-breaking bug — verify this specifically in the real staging topology, don't just trust the fix blindly. |
| | Liveness/readiness independent of Redis | PASS (fixed Phase 19) | Found via real chaos testing: `/api/health/live` used to hang for the length of a Redis outage because session middleware ran before it. Fixed by mounting `/live`+`/ready` before session/rate-limit middleware — now responds in well under 2s even during a real Redis outage. |
| | No stack traces leaked on an unhandled error | PASS (fixed Phase 19) | Found via the same chaos test: an unhandled Redis error used to fall through to Express's default HTML error page, including real server file paths. Fixed with a global JSON error handler. |
| **Database** | Schema creates cleanly on a fresh DB | PASS | Real fresh-boot test, re-verified in Phase 19's CI run and clean-checkout test. |
| | `DB_PATH` override works for a mounted volume | PASS | Tested for real — custom path used, default path untouched. |
| | Existing-database migration (real pre-existing data) | PASS (Phase 19) | Hand-built a database on the OLDEST base-column schema shape with real data in it, booted the current code against it: every outstanding column addition applied, zero data loss, a `NOT NULL DEFAULT` column backfilled correctly on old rows. 4 real assertions. |
| | Migration rollback strategy | PASS (by construction, documented not "fixed") | No separate migration framework — every change is an additive `ALTER TABLE ADD COLUMN`. Confirmed by source grep: zero `DROP TABLE`/`DROP COLUMN`/`RENAME` statements anywhere, so a code rollback after a schema change is inherently safe (older code just never touches the new column). |
| | Backup script runs against a live server | PASS | Real backup, real integrity/row-count verification, re-run in Phase 19 with fresh data. |
| | Restore script recovers from real corruption / to a fresh target | PASS | Real corrupt-then-restore-then-verify cycle; Phase 19 additionally verified a restored database boots a real server and a real user can log in against it. |
| | Continuous replication (Litestream) | EXTERNAL SETUP REQUIRED | Needs a real S3 bucket + sidecar process. |
| **Storage** | Local storage provider | PASS | Existing, working. |
| | S3 storage provider | EXTERNAL SETUP REQUIRED | Code is real (existing Phase 14 work) but needs a real bucket to test against. |
| **Queue / Workers** | In-process job processing | PASS | Existing, working, re-verified. |
| | Standalone `worker.js`, multi-process, real hard-kill | PASS (extended Phase 19) | Phase 18.3's original 2-process test extended: 2 REAL `node worker.js` OS processes, 300 real jobs, one process hard-`SIGKILL`ed mid-burst — zero duplicate execution (every job's `attempts` is exactly 1), all 300 jobs reach `completed`, both real worker PIDs appear in results. |
| | Worker-crash job reclaim | PASS (real gap found and fixed Phase 19) | A worker killed (not gracefully shut down) mid-job used to leave that job at `status='running'` forever, with nothing to ever notice or retry it. Fixed with a stale-job reclaim sweep on every processing tick; 5 real regression checks. |
| | Redis-backed queue provider | NOT APPLICABLE (by design) | Real and independently tested, but deliberately not wired into the live job-processing path — see `jobs/queueProvider.js`'s own file-level comment. Horizontal scaling comes from WAL-mode SQLite + multiple `worker.js` processes instead. |
| **Redis** | Cache provider | PASS | Real, tested against local `redis-server`. |
| | Rate limiter provider | PASS | Real, tested — including a full regression run with it active. |
| | Rate limiter fails OPEN on a real Redis outage | PASS (real gap found and fixed Phase 19) | The global rate limiter is applied to every `/api/*` request — it used to fail CLOSED on a Redis error, meaning a single Redis blip took down 100% of API traffic with 500s, not just rate-limiting. Fixed to fail open (logged as degraded) instead. Verified with a real `redis-server` spawned and then `SIGKILL`ed mid-run. |
| | Session store provider | PASS | Real, tested — including surviving a hard process kill. Deliberately still fails CLOSED on a Redis outage (a session-store failure gates identity, not just abuse-prevention) — see Notes on the `SESSION_STORE=redis` row below. |
| | `SESSION_STORE=redis` + a real Redis outage | FAIL (real, documented infrastructure requirement, not further patched) | An authenticated request correctly returns a clean JSON 500 (not a stack trace, not a hang) during a real Redis outage when `SESSION_STORE=redis` — but it does fail. A production deployment choosing `SESSION_STORE=redis` needs Redis itself to be highly available (Sentinel/Cluster/managed HA) for authenticated traffic to survive a Redis blip; this is inherent to the architecture choice, not a code bug to fix further. |
| | Connectivity health check (`/health/redis`) | PASS | Tested in all 3 real states (unconfigured/reachable/unreachable), including mid-outage during Phase 19's chaos test. |
| **Secrets** | `SESSION_SECRET`/`BYOK_ENCRYPTION_KEY` enforcement | PASS | Startup validator refuses a weak/missing value in production. |
| | Secrets never logged | PASS | Structured logger has a redaction safety net; manual review found no secret-logging call sites. |
| | OAuth tokens encrypted at rest | PASS (fixed Phase 18.1) | AES-256-GCM, transparent decrypt-on-read, 27 real assertions. Old plaintext connections from before this fix safely degrade to "please reconnect," never a crash or a garbage token. |
| **OAuth** | Gmail/Google-services OAuth flow (real account) | EXTERNAL SETUP REQUIRED | Code-reviewed, CSRF/encryption/revocation all real and tested at the code level, never run against a real Google account. |
| | Meta OAuth flow (real account) | EXTERNAL SETUP REQUIRED | Same status as Google. |
| | OAuth revocation on real disconnect (provider side) | PASS (implemented Phase 18.2) code-level / EXTERNAL SETUP REQUIRED for the live-provider round trip | Google (`/revoke`) and Meta (`/me/permissions`) both get a real revoke call on disconnect, with a bounded 10s timeout and honest success/failure reporting — 11 real regression checks against a mocked provider boundary. |
| | Local credentials cleared on disconnect regardless of revocation outcome | PASS | A failed provider-side revocation is never treated as a reason to leave local credentials usable. |
| | Shopify/WooCommerce/WordPress/WhatsApp revocation | NOT APPLICABLE (inherent to the credential type, not a code gap) | Manual tokens/API keys/application passwords have no revoke call this app can make — see `PHASE18_2_NOTES.md` §3. Local credentials are still fully deleted on disconnect. |
| | Cross-org connection isolation | PASS (verified live, Phase 18.2) | 15 real regression checks. |
| | Disconnect-during-refresh race | PASS (found and fixed Phase 18.2) | Verified with a real race simulation. |
| | Queued job / worker credential safety | PASS | Verified against the real Job Manager. |
| | Cache invalidation | PASS (by construction) | No integration connection or token is ever cached anywhere — every read is a fresh, real, decrypted DB read. |
| **Webhooks** | Stripe webhook signature verification | PASS | Real code review — Stripe's own SDK, correct. |
| | Stripe webhook idempotency | PASS | Real dedup table, namespaced correctly. |
| | Stripe webhook — actually received a real event | EXTERNAL SETUP REQUIRED | No Stripe account in this sandbox. |
| | Developer webhook delivery (Public API) — code path | PASS | Signing, timestamp/replay protection, SSRF protection, retry/backoff all real and regression-tested. |
| | Developer webhook delivery — real outbound round trip to a public endpoint | BLOCKED | Attempted in Phase 19 for real (not simulated): this sandbox's outbound network policy returns `403` from the egress gateway for every generic public test endpoint tried (httpbin.org, postman-echo.com, webhook.site, requestbin.com, example.com — confirmed via the proxy's own status/logs, which explicitly say "do not retry or route around it"). Only an explicit allowlist of domains (GitHub, npm, PyPI, etc.) is reachable. This is a genuinely different situation from "needs a Stripe account" — the code path is real and tested up to the SSRF-validator boundary; only the live network hop is blocked here. See `EXTERNAL_INFRASTRUCTURE.md`. |
| **AI Providers** | Provider abstraction / failover | PASS | Existing Phase 16 work, unchanged, re-verified passing. |
| | Real AI provider call | EXTERNAL SETUP REQUIRED | No API key configured in this sandbox for any run in this phase. |
| **Billing / sandbox** | Quota/spend-limit enforcement | PASS | Existing Phase 16 work, re-verified in every Phase 18/19 configuration. |
| | Stripe test-mode checkout | EXTERNAL SETUP REQUIRED | No Stripe account. |
| **Email** | Transactional email (invites, password reset) | FAIL (known gap) | No email provider integrated — invited users must be told out-of-band today. |
| **Monitoring** | Structured logging | PASS | Real JSON logs, request-ID correlation verified. Phase 19's global error handler now also always logs the real error server-side even when the client only sees a generic message. |
| | Health checks (liveness/readiness/deep) | PASS | All tested, including real Redis outage in Phase 19 — liveness/readiness now genuinely independent of Redis. |
| | External error tracking | EXTERNAL SETUP REQUIRED | No service integrated (Sentry/Datadog/etc.). |
| | External uptime monitoring / alerting | EXTERNAL SETUP REQUIRED | No service integrated. |
| **Mobile** | Environment config (`--dart-define`) | EXTERNAL SETUP REQUIRED | Code-reviewed, not compiled — no Flutter SDK available in this sandbox. |
| | Session-expiry handling | EXTERNAL SETUP REQUIRED | Real gap found and fixed at the code level; not compiled/run. |
| | Push notifications | EXTERNAL SETUP REQUIRED | Needs a real Firebase project + device to test delivery. |
| | Platform build (Android/iOS) | BLOCKED | `android`/`ios` platform folders not fully scaffolded, and `flutter` is not on `PATH` in this sandbox (re-confirmed Phase 19: `which flutter` returns nothing) — no real build has ever been produced. |
| **Public API** | Auth, scopes, rate limits | PASS | 30/30 regression checks, every configuration, re-verified on real GitHub Actions in Phase 19. |
| | SDKs (JS + Python) | PASS | Both smoke-tested end-to-end against a live server with a real provisioned API key, both locally and on real GitHub Actions (Phase 19). |
| | OpenAPI spec validity | PASS | Validated with `openapi-spec-validator`, 39 paths, both locally and on real GitHub Actions. |
| **Admin** | Access control (session/role checks) | PASS | Fresh DB check every request, no stale-session privilege risk. |
| | Audit logging | PASS | Confirmed it survives an org's own deletion (Phase 18.10 fix). |
| **Backups** | Scheduled backup execution | EXTERNAL SETUP REQUIRED | The script is real and tested; nothing runs it on a schedule yet — needs a real cron/scheduler in staging. |
| **Security** | Security headers (CSP/HSTS/etc.) | PASS | Real browser-verified, zero violations. |
| | CORS (dev permissive / prod fail-closed) | PASS | Verified both modes via real requests. |
| | Tenant isolation / IDOR / privilege escalation | PASS | 24/24 regression checks, every configuration, re-verified on real GitHub Actions. |
| | Org/API-key deletion cascades | PASS (fixed across two phases) | Real regression tests cover this. |
| | User account self-deletion | NOT APPLICABLE | No such feature exists by design — only org deletion. |
| | CI/CD pipeline — actually runs, not just dry-run | PASS (upgraded Phase 19) | Previously "dry-run locally against this exact repo"; Phase 19 fired the real pipeline on a real GitHub Actions runner via `workflow_dispatch` three times, found and fixed two real bugs the sandbox alone never would have caught (a CI-only env-propagation bug, and confirmed the new chaos tests work against a fresh runner that has to `apt-get install redis-server` from scratch), and the pipeline is now fully green — all 8 jobs, every regression suite. |
| | Docker build | BLOCKED | `docker` CLI is present but no daemon is reachable in this sandbox (`docker info` fails with "no such file or directory" on the socket) — syntax-reviewed + `docker compose config`-validated only, re-confirmed unchanged in Phase 19. |
| | Load testing | PASS (as a methodology, not a capacity number) | Re-run fresh in Phase 19 — consistent with the Phase 18.8 numbers, zero errors. |
| | Controlled failure/chaos testing | PASS (Phase 19, new) | Real Redis kill mid-run, real worker hard-kill mid-burst — see the Redis/Queue rows above for the 3 real bugs this found and fixed. |
| **Deployment** | Clean-checkout reproducibility | PASS (Phase 19, new) | A real `git clone` → `npm ci` (server + client) → client build → fresh-DB migrate → boot → health check → real regression suite (24/24), all from a completely separate scratch checkout of this exact branch. Nothing about the deployment process depends on leftover state from earlier work in this sandbox. |
| **Hosting** | Real hosting platform provisioned | EXTERNAL SETUP REQUIRED | No hosting has been purchased/provisioned. See `EXTERNAL_INFRASTRUCTURE.md` and `PRODUCTION_COST_ESTIMATE.md`. A `REPLIT_SETUP.md` already exists in this repo suggesting Replit as one candidate, and a `Replit` MCP connector was visible but unauthenticated this session — authorize it if you want a real deployment attempted there. |
| | Real domain + DNS + TLS | EXTERNAL SETUP REQUIRED | No domain purchased/pointed at anything from this sandbox. |

## Reading this checklist

**PASS** items are safe to trust as-is when standing up staging — they
were genuinely exercised in this environment (or, for CI/SDK items this
phase, against the real GitHub Actions service), not just written and
assumed correct.

**EXTERNAL SETUP REQUIRED** items aren't failures — they're things this
sandboxed environment structurally cannot test (no real Stripe account,
no real OAuth credentials, no Docker daemon, no Flutter SDK, no real
cloud infrastructure, no hosting/domain purchased). Test them for real
the first time staging actually has that infrastructure, using the
procedures in `DEPLOYMENT_RUNBOOK.md` and `EXTERNAL_INFRASTRUCTURE.md`.

**BLOCKED** items are a step further than "needs infrastructure" — a
specific, identified reason (an organizational network egress policy, a
missing daemon) prevents testing from this exact sandbox even with
different credentials. Worth re-attempting from a real staging host,
which won't have the same restriction.

**FAIL** items are real, known gaps worth fixing before they matter at
scale — none of them block standing up a first staging environment, but
none of them should be forgotten either.

See `PHASE19_NOTES.md` for the full Phase 19 completion report, and
`LAUNCH_BLOCKERS.md` for these same items prioritized P0-P3.
