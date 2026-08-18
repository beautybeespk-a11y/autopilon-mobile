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
| Server (Express/Node) | READY | Boots cleanly; all 10 regression suites (121 checks total — see Phase 18.1 additions below) pass against a live instance in every configuration tested. |
| Database (SQLite, WAL mode) | READY | Real schema, real FK cascades (now complete, including a Phase 18.1 fix — see Deletion Cascades below), `DB_PATH` override tested for real. |
| Mobile app (Flutter) | CODE READY / EXTERNAL BUILD TEST REQUIRED | Code-reviewed and edited (environment config with fail-loud staging/prod URL resolution, no embedded backend secrets, session-expiry handling) but **never compiled or run** — no Flutter SDK anywhere this project has been built (re-confirmed in Phase 18.1: `flutter` is not on PATH in this sandbox). `android/`/`ios/` platform folders are not fully scaffolded either. Must be built and run with a real Flutter toolchain before any of this is trusted — no build result is claimed here. |
| Public API (v1) | READY | Existing Phase 17 work, re-verified: 30/30 Public API regression checks pass in every configuration, including after Phase 18.1's changes. |
| Admin Panel | READY (after this phase's fix) | Access control re-verified for real in Phase 18.1 (dedicated 9-check regression suite: auth-before-role, non-admin denied on 10 endpoints, org-ownership doesn't grant admin access, no credential leakage in responses). Found and fixed one real gap: an admin's plan-definition edits were being logged but never actually surfaced in the admin's own billing audit log, due to an action-name mismatch (`"plan_updated"` vs. the filter's `"plan_changed"`) — fixed. |

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
| Standalone worker (`worker.js`) | READY | Real multi-process test: two independent worker processes sharing one SQLite file correctly split real job load with zero duplication; graceful shutdown on SIGTERM confirmed. Extended in Phase 19 with a real hard-`SIGKILL` mid-burst (300 real jobs, one of two processes killed abruptly) — still zero duplicate execution. |
| Worker-crash job reclaim | READY (real gap found and fixed Phase 19) | A worker that crashes (killed, not gracefully shut down) mid-job used to leave that job at `status='running'` forever — nothing ever noticed or retried it. Fixed with a stale-job reclaim sweep, reusing the exact retry/dead-letter branching an ordinary handler failure already gets. 5 real regression checks. |
| Rate limiter behavior on a real Redis outage | READY (real gap found and fixed Phase 19) | The global rate limiter (applied to every `/api/*` request) used to fail CLOSED on a Redis error — a single Redis blip took down 100% of API traffic with 500s. Fixed to fail OPEN (logged as degraded), verified against a real `redis-server` that was spawned and then killed mid-run. |
| Session cookie security | READY (after this phase's fix) | Phase 18.11 found and fixed a real, critical bug: without `trust proxy`, the production `secure: true` cookie was **never sent** behind any real reverse proxy — verified via realistic `X-Forwarded-Proto` simulation. |

## Security

| Component | Status | Notes |
|---|---|---|
| Security headers (CSP, HSTS, etc.) | READY | Real helmet config tuned to the client's actual asset origins; verified via a real headless browser with zero CSP violations. |
| CORS | READY | Dev: permissive (unchanged). Production: explicit allowlist, fails closed if `CLIENT_ORIGIN` unset — verified via real curl requests in both modes. |
| Tenant isolation / IDOR / privilege escalation | READY | Existing Phase 16 protections, re-verified passing in every Phase 18 configuration (24/24 security regression checks). |
| OAuth CSRF protection | READY (re-verified Phase 18.1) | The weak-RNG `state`-generation fix (Gmail/Google-services/Meta, now `crypto.randomBytes`) has a dedicated 7-check regression suite as of Phase 18.1: fresh high-entropy state per call, garbage/missing state rejected, correct state accepted, single-use (replay rejected), cross-user isolation, and concurrent-`/connect`-call safety. |
| OAuth/integration token encryption at rest | READY (fixed this phase) | **Was the top-priority known gap** — access/refresh tokens (OAuth and manual, e.g. a WooCommerce consumer secret or WordPress application password) are now AES-256-GCM encrypted before ever touching the database, decrypted transparently on read in `integrations/manager.js` so none of the 12+ existing call sites needed to change. A decrypt failure (wrong key, corrupted data, or a pre-encryption plaintext row) degrades safely to "please reconnect," never a crash or garbage token. 27 real assertions (encrypt/store/read/decrypt/refresh/revoke/disconnect/invalid-ciphertext/wrong-key/cross-org-isolation), all passing. See `PHASE18_1_NOTES.md` §1 for the migration story (old plaintext tokens simply stop decrypting and prompt reconnect — no real production users have ever existed against this schema). |
| OAuth token revocation on disconnect | READY (fixed Phase 18.2) / EXTERNAL TEST REQUIRED for live-provider confirmation | Was the one remaining application-level gap Phase 18.1 flagged. Disconnect now calls the real provider revoke endpoint before wiping local credentials — Google's `/revoke` (invalidates the whole grant via the refresh token) and Meta's `/me/permissions` de-authorize, both with a bounded 10s timeout and honest `{revoked, revocationError}` reporting so a failed provider call is never silently reported as full success. A failed revocation is never treated as permission to leave local credentials usable — local wipe always runs regardless. 11 real regression checks (provider endpoint construction, success, failure, timeout, network error, no-token-to-revoke). Never tested against a real Google/Meta account (no live credentials in this sandbox) — see below. |
| OAuth/manual-credential revocation, non-OAuth providers (Shopify/WooCommerce/WordPress/WhatsApp) | NOT SUPPORTED (inherent to the credential type) | None of the four has a revoke call this app can make on the user's behalf — a manual admin API token, a consumer key/secret pair, an application password, and a Meta System User token are each either provider-side-only to revoke or, for WhatsApp specifically, too risky to touch programmatically (see `PHASE18_2_NOTES.md` §3). Local credentials are still fully deleted on disconnect in every case — only the provider-side revoke call is unavailable. |
| Disconnect-during-token-refresh race | READY (found and fixed Phase 18.2) | A refresh in flight when a disconnect landed used to silently resurrect the connection (new access token, and the OLD refresh token) once the refresh resolved. Fixed: the refresh path now re-checks the connection is still connected before persisting anything, discarding the refreshed token if not. Verified with a real race simulation, not just reasoned about. |
| Queued job / background worker credential safety | READY (verified Phase 18.2) | A job queued before an integration is disconnected, but processed by a worker afterward, fails safely instead of using the stale credential — verified against the real Job Manager and queue provider, not a mock of either. Also found and fixed a smaller correctness gap in the same pass: the "not connected" error is now marked non-retryable, so such a job fails immediately instead of cycling through 3 pointless retries before dead-lettering. |
| Cache invalidation for integration credentials | READY (by construction) | No integration connection or token is cached anywhere in this app — in-process or Redis — confirmed by a full code audit of the integrations layer plus a direct regression check. There is nothing to invalidate because nothing is ever cached; every credential read is a fresh, real, decrypted database read. |
| Credential leakage (API responses, logs, admin panel, errors) | READY (audited Phase 18.1) | Full-codebase audit: every response shape that reads a connection, every integration API client's error path, every admin-panel response, and developer-webhook payload construction — all confirmed to never surface a token/secret value. Found and fixed one real leak vector: WooCommerce's API client sent consumer key/secret as URL query params even over HTTPS (real risk: server access logs, CDN logs, `Referer` headers) — switched to HTTP Basic Auth over HTTPS, matching WooCommerce's own documented recommendation. 8-check permanent regression suite added. |
| Stripe webhook security | READY | Real signature verification (Stripe's own SDK), real idempotency, correct retry semantics — verified by code review, matches Phase 16-era `.env.example` documentation exactly. |
| Session/cookie security | READY | `httpOnly`, `SameSite=Lax`, `secure` in production (now actually reachable behind a proxy — see trust-proxy fix above), non-default cookie name. Phase 18.1 added a dedicated regression suite (7 checks across direct and behind-proxy configurations) that also surfaced a previously-unverified but correct behavior: with the trusted `X-Forwarded-Proto` signal absent, the session cookie is not sent at all (fail-safe), rather than being sent without the `Secure` flag. |
| Reverse-proxy / `trust proxy` behavior | READY (re-verified Phase 18.1) | The Phase 18 fix now has its own regression suite, run in both configurations: outside production, spoofed proxy headers are provably ignored (an 11th request with a fresh fake IP each time still hits the real rate limit); in production, the cookie's `Secure` flag genuinely depends on the trusted signal, and distinct real clients behind the same proxy get independent rate-limit buckets. Documented, not "fixed": a client connecting directly (bypassing the real proxy) can spoof its own client IP — inherent to Express's numeric `trust proxy` config, which is why production must keep this process unreachable except through the configured proxy. |
| Mobile token storage | READY | No bearer tokens or secrets stored client-side — real cookie-jar-based session auth, verified by reading the full storage implementation. No backend secrets (AI provider keys, Stripe keys, encryption keys) are embedded in the mobile app source (Phase 18.1 grep confirmed zero matches). The one credential-shaped value present, a Firebase client API key in `google-services.json`/`firebase_options.dart`, is Google's own documented pattern for Firebase mobile apps (not a secret by itself — access is enforced by Firebase Security Rules) and was flagged for review, not treated as a leak. |
| Mobile session expiry | READY (after Phase 18.9's fix) | Real gap found and fixed: no mid-session 401 detection existed before Phase 18.9 — added, code-reviewed but **not compiled/run** (no Flutter SDK). |
| Org/API-key/account deletion cascades | READY (org-level; account-level not implemented) | Found and fixed a real, significant bug in an earlier phase: deleting an org orphaned data (including real files on disk) across many tables with no FK enforcement. Phase 18.1's dedicated re-verification pass found one more real gap the earlier fix missed: `conversations.agentId` had no foreign key to `agents` at all, so conversations (and their message content) held with an org's agent survived the org's deletion, orphaned rather than removed — real chat content persisting indefinitely with no owning tenant. Fixed; a 10-check regression suite (including a direct assertion that sensitive message content is unreadable from any surviving row after deletion, and that the audit trail is correctly preserved) now covers this. User-initiated account self-deletion does not exist at all (see below). |

## Observability

| Component | Status | Notes |
|---|---|---|
| Structured logging | READY | Real JSON logs with request IDs, verified matching between the `X-Request-Id` response header and the actual log line for a real request. |
| Health checks (liveness/readiness/deep) | READY | `/live`, `/ready` public and minimal (correct for infra probes); admin-gated deep checks including a real Redis connectivity check tested in all 3 real states (unconfigured/reachable/unreachable). Phase 19 found and fixed a real bug via a real Redis-outage chaos test: `/live` used to hang for the length of ioredis's retry exhaustion because session middleware (which touches Redis on every request) ran before it — fixed by mounting `/live`+`/ready` before session/rate-limit middleware entirely, so liveness now genuinely reflects "is the process itself fine," independent of any downstream dependency. |
| Unhandled-error response safety | READY (real gap found and fixed Phase 19) | The same chaos test found that an unhandled Redis error fell through to Express's default HTML error page, leaking real server filesystem paths in a stack trace and breaking the JSON-only response contract every other endpoint has. Fixed with a global 4-arg error-handling middleware: the real error is logged server-side via the structured logger; the client only ever sees a generic message + request id. 3 real regression checks lock this in (`test:redis-outage-failsafe`). |
| Error tracking (external service) | NOT IMPLEMENTED | No Sentry/equivalent integrated. Structured logs are real, useful input for one, but nothing external is wired up. |
| Alerting | NOT IMPLEMENTED | No paging/alerting system exists. This is inherent to not having a monitoring service in the loop at all. |
| Cost visibility dashboard | NOT IMPLEMENTED | No AI-cost/infra-cost/margin tracking beyond what Phase 16's existing per-org spend limits already provide. |

## Data & Backup

| Component | Status | Notes |
|---|---|---|
| Database backup/restore scripts | READY | Real, tested end-to-end: backup against a live server, genuine corruption of the working DB, restore, verified row-level data survives — including proof that post-backup writes are correctly *not* restored (real RPO characteristic). Re-verified fully in Phase 19 with fresh data, plus a new check: the restored database boots a real server and a real user can log in against it (not just "the file passes integrity_check"). |
| Existing-database migration (real pre-existing data) | READY (Phase 19) | Hand-built a database using the OLDEST base-column schema shape (taken verbatim from `db.js`'s own base `CREATE TABLE` statements) with real data in it, then booted the current code against it. Every outstanding `ALTER TABLE ADD COLUMN` applied correctly, zero data loss, a `NOT NULL DEFAULT` column backfilled correctly on pre-existing rows. 4 real assertions (`test:db-migration`). |
| Migration rollback strategy | READY (by construction) | No separate migration framework exists — every schema change is an additive, PRAGMA-guarded `ALTER TABLE ADD COLUMN`. Confirmed by direct source grep: zero `DROP TABLE`/`DROP COLUMN`/`RENAME` statements anywhere in `db.js`, so a code rollback to an older release after a schema change is safe by construction (older code simply never reads/writes the new column) — documented rather than "tested," since there is no destructive operation to roll back in the first place. |
| Continuous replication (Litestream) | ARCHITECTURE ONLY | Documented as the recommended real production strategy; requires an S3 bucket and a long-running sidecar process not available here. |
| Disaster recovery beyond DB | NOT IMPLEMENTED | No documented/tested recovery procedure for object storage, secrets, DNS, or a full app redeploy — only the database layer was covered in this phase. |

## CI/CD & Deployment

| Component | Status | Notes |
|---|---|---|
| CI workflow (`.github/workflows/ci.yml`) | READY — genuinely verified on real GitHub Actions (Phase 19) | Previously only dry-run locally. Phase 19 expanded the pipeline from 4 to all 20 regression suite files (adding csrf/credentialLeakage/productionLogging/dataRetention/adminPanel/reverseProxy-both-modes and all 10 new Phase 18.2/19 suites), added a `workflow_dispatch` trigger, and fired it for real against a genuine GitHub Actions runner 3 times via the GitHub API. The first real run caught a real bug no local dry-run had (an env-var propagation gap specific to how GitHub Actions steps don't share inline `run:` env vars) — fixed, and the pipeline is now fully green: all 8 jobs, including a new job that installs a real `redis-server` binary via `apt-get` on a fresh runner and spawns/kills real child processes for the multi-worker and Redis-outage chaos tests. |
| Dockerfile / docker-compose.yml | REQUIRES TESTING | Syntax-reviewed, `docker compose config` validated the full schema — but **never actually built or run**; re-confirmed in Phase 19 that no Docker daemon is reachable in this sandbox (`docker info` fails on the socket, though the CLI itself is present). |
| Deployment runbook | READY (verified reproducible, Phase 19) | See `DEPLOYMENT_RUNBOOK.md`. Phase 19 performed a real clean-checkout deployment test: a completely separate `git clone` of this branch, `npm ci` for server and client, a real client build, a fresh-database migrate, boot, health check, and a real regression suite run (24/24) — all reproduced successfully from nothing but the checkout, proving the documented procedure isn't just internally consistent, it actually works end to end. |
| Rollback procedure | READY (as documentation, real backup/restore verified) | Documented in `DEPLOYMENT_RUNBOOK.md`; the backup/restore mechanism it depends on is real and tested (including, in Phase 19, a full restore→boot→login cycle). A full multi-instance app-rollback rehearsal (blue/green or similar) has not been performed — that needs real hosting infrastructure this sandbox doesn't have. |
| Zero-downtime deployment | NOT IMPLEMENTED (as a measured claim) | Graceful shutdown (`worker.js`'s SIGTERM handler, letting in-flight jobs finish before exiting) and readiness/liveness separation are real and code-reviewed, but no actual zero-downtime deploy has been measured — that needs a real load balancer/orchestrator in front of more than one instance, which this sandbox doesn't have. |

## Load & Capacity

| Component | Status | Notes |
|---|---|---|
| Load testing scripts | READY | Real autocannon-based scripts, real measured results (see `LOAD_TEST_RESULTS.md`) — explicitly labeled single-process sandboxed dev-instance numbers, not a production capacity claim. |
| Production capacity | NOT IMPLEMENTED (as a claim) | No number in this repo should be read as "the platform can handle X req/s in production" — that requires real hardware and a real dataset, neither available here. |

## Billing

| Component | Status | Notes |
|---|---|---|
| Stripe integration (existing) | READY AFTER EXTERNAL CONFIGURATION | Code is real and correct (verified across two review passes); real signature verification, real idempotency, correct retry semantics, correct quota/usage sync on plan changes — but has never received a real event, since no Stripe account exists in this sandbox. Needs a real Stripe TEST-mode account + webhook registration; see `EXTERNAL_INFRASTRUCTURE.md` and `DEPLOYMENT_RUNBOOK.md` §12 step 14 for the exact staging test procedure. **EXTERNAL STAGING TEST REQUIRED** before any billing claim is made. |
| Quota/spend-limit enforcement | READY | Existing Phase 16 work, re-verified passing in every configuration tested, including after Phase 18.1's changes. |

## External Delivery (Email / Developer Webhooks)

| Component | Status | Notes |
|---|---|---|
| Transactional email | NOT IMPLEMENTED | No email provider is integrated anywhere in this codebase. `routes/organizations.js`'s member-invite flow and `routes/auth.js`'s `/forgot-password` both explicitly have no outbound-email path (invited users are told out-of-band today; forgot-password returns an acknowledgment with no actual email sent). This is a missing feature, not an untested one — nothing to stage-test until it's built. |
| Developer webhook delivery (outbound, Public API) | READY (code) / BLOCKED for the live round trip specifically in this sandbox | Signing, timestamp/replay protection, retry/backoff, and SSRF protection on webhook creation are all real and covered by the Public API security regression suite (30/30, including 5 dedicated signing/SSRF checks). Phase 19 attempted a real delivery to several genuinely public test endpoints (httpbin.org, postman-echo.com, webhook.site, requestbin.com, example.com) — all were rejected with `403` by this sandbox's own organizational network egress policy (confirmed via the proxy's own status/logs, which explicitly say not to retry or route around it). This is a sandbox network restriction, not a code gap or a "needs an account" situation — a real staging host with normal internet egress should complete this test with no code changes. See `DEPLOYMENT_RUNBOOK.md` §12 step 15 for the exact staging checklist. |

## Mobile Production Config

| Component | Status | Notes |
|---|---|---|
| Environment config (`--dart-define`) | REQUIRES TESTING | Replaces the hardcoded dev URL with real dev/staging/prod resolution — code-reviewed, brace/paren-balance-checked, but not compiled. |
| App Store / Play Store readiness | NOT READY | Platform folders (`android/`, `ios/`) aren't fully scaffolded; no real build has ever been produced. |
| Push notifications | READY AFTER EXTERNAL CONFIGURATION | Implemented (Firebase Admin SDK) since an earlier phase; needs a real Firebase project + APNs cert to actually deliver anything. |

## Hosting & Real Staging Deployment (Phase 19)

| Component | Status | Notes |
|---|---|---|
| Real hosting platform | NOT READY / PRODUCTION BLOCKER for an actual staging URL | No hosting has been purchased or provisioned from this sandbox — it cannot create accounts, provide payment details, or reach arbitrary hosting-provider consoles. The application code is deployable as-is (Docker image, or a plain Node process) to any Node-capable host; see `PRODUCTION_COST_ESTIMATE.md` for the infrastructure categories to budget and `EXTERNAL_INFRASTRUCTURE.md` for exact setup steps. A `REPLIT_SETUP.md` already exists in this repo and a `Replit` MCP connector was visible but unauthenticated during this phase — authorizing it would let a future session attempt a real deployment there directly. |
| Real domain + DNS + TLS | NOT READY / PRODUCTION BLOCKER | No domain purchased or pointed at anything. `trust proxy`/CORS/cookie behavior is all real and tested against simulated proxy headers (Phase 18.1/18.11); the one thing genuinely untested is the real browser-to-real-domain round trip, which needs an actual domain + TLS cert to exist. |
| Multi-tenant isolation against a real staging database | READY (verified against the real production schema, sandbox-hosted) | Every isolation check in this document (24/24 tenant-isolation regression, 15/15 reconnect/cross-org, 30/30 Public API cross-org) already runs against the real `db.js` schema, real foreign keys, real WAL-mode SQLite — the same database engine and schema staging would use. What's untested is a *separately-provisioned* database service (Postgres-as-a-service, a managed SQLite host, etc.) if the hosting choice moves away from a co-located SQLite file — that's a hosting decision this sandbox can't make on the owner's behalf. |

## What genuinely changed this phase that a reader should trust without re-verifying

Every "READY" line above that references a specific real test (a live
server boot, a real browser, a real Redis instance, a real killed-and-
restarted process, a real corrupted-then-restored database, a real
multi-process worker run, a real curl request with a simulated proxy
header) reflects something that was actually run in this environment
during Phase 18 or Phase 18.1, not reasoned about. Anything marked
REQUIRES TESTING, ARCHITECTURE ONLY, or EXTERNAL STAGING TEST REQUIRED
was deliberately not claimed as more than that.

Phase 18.1 re-ran every regression suite from Phase 18 plus six new ones
written specifically for this hardening pass (OAuth token encryption,
credential leakage, reverse-proxy/session behavior, CSRF, data retention,
admin panel security) against one freshly-migrated live server —
121/121 checks passing. See `PHASE18_1_NOTES.md` for the full breakdown,
the production launch blocker list, and every fix made during this pass.

Phase 18.2 closed the one application-level gap Phase 18.1's own report
identified (OAuth revocation on disconnect) and re-ran every regression
suite that now exists — the 10 pre-existing suite files from Phase
16/17/17.1/18/18.1 (one of which, `integrationActionRegression.js`,
gained 3 new disconnect/reconnect checks this phase) plus 6 new suites
written for this pass (OAuth revocation, queued-job credential safety,
token refresh safety, reconnect/isolation, audit logging + API response
security, failure handling + concurrency) — a freshly measured 174/174
checks passing across 16 suite files, run against clean servers booted
fresh for this phase (not carried over from an earlier count). See
`PHASE18_2_NOTES.md` for the full breakdown and the updated production
launch blocker list (unchanged in substance from Phase 18.1's, minus the
revocation item, which is now resolved).

## Phase 18.2 Final Test Matrix

Every suite below was run to completion against a freshly booted server
(fresh `DB_PATH`, no state carried over between suites) as the very last
step of this phase, specifically to produce this table — not copied
forward from an earlier run.

| Test | Result | Environment | Notes |
|---|---|---|---|
| OAuth token encryption at rest | 27/27 | Sandbox (mocked provider boundary) | Phase 18.1 work, re-verified unchanged. |
| OAuth disconnect + provider revocation (Google, Meta) | 11/11 | Sandbox (mocked provider boundary) | `test:oauth-revocation`. Real revoke-endpoint construction, `invalid_token`-as-success, honest failure reporting, idempotent double-disconnect. Live-provider round trip is EXTERNAL TEST REQUIRED. |
| Credential deletion on disconnect | included above + 8/8 | Sandbox | Covered by `test:oauth-revocation` and `test:credential-leakage`. |
| Token refresh safety (valid/expired/revoked/concurrent/disconnect-race) | 7/7 | Sandbox (mocked provider boundary) | `test:token-refresh-safety`. Found and fixed a real disconnect-during-refresh resurrection race. |
| Reconnect lifecycle (connect→use→disconnect→reconnect→use) | 15/15 | Sandbox | `test:reconnect-isolation`. Clean pass, no bugs found. |
| Cross-user isolation | included above | Sandbox | Same suite as reconnect. |
| Cross-org isolation (incl. personal+org coexistence for one provider) | included above | Sandbox | Same suite; specifically exercises the Phase 18.1 schema fix. |
| Cache invalidation | confirmed by code audit + 4/4 | Sandbox | No caching layer exists for integration connections anywhere (grep-verified); `test:queued-job-credential-safety` includes a direct no-stale-read check. |
| Queued job / worker credential safety | 4/4 | Sandbox | `test:queued-job-credential-safety`. Found and fixed a retry-forever gap on a permanently-unfixable disconnect error. |
| WooCommerce credential security (no URL leak) | 8/8 | Sandbox | `test:credential-leakage`, includes a dedicated regression check for the Phase 18.1 URL-leak pattern. |
| Integration Action API (disconnected/revoked credential rejection) | 15/15 | Sandbox | `test:integration-actions`, +3 new checks this phase. |
| Audit logging (new event taxonomy surfaced correctly) | 5/5 | Sandbox (in-process HTTP) | `test:audit-api-response`. |
| API response security (no tokens/secrets in any response) | included above | Sandbox | Same suite. |
| Failure handling (401/403/timeout/network error) | 9/9 | Sandbox (mocked provider boundary) | `test:failure-concurrency`. |
| Idempotent + concurrent disconnect / connect races | included above | Sandbox | Same suite. |
| Core security regression (tenant isolation, billing, webhook replay, BYOK) | 24/24 | Sandbox | `test:security`, unchanged from Phase 18.1. |
| Public API security (scopes, rate limits, secrets) | 30/30 | Sandbox | `test:security:public-api`, unchanged. |
| Idempotency-Key handling | 10/10 | Sandbox | `test:idempotency`, unchanged. |
| CSRF (OAuth state param) | 7/7 | Sandbox | `test:csrf`, unchanged. |
| Production logging redaction | 3/3 | Sandbox | `test:production-logging`, unchanged. |
| Data retention / deletion cascades | 10/10 | Sandbox | `test:data-retention`, unchanged. |
| Admin panel access control + response security | 9/9 | Sandbox | `test:admin-panel`, unchanged. |
| Reverse-proxy / session security (direct + proxy mode) | 7/7 | Sandbox | `test:reverse-proxy`, unchanged, both `NODE_ENV` configurations. |
| **Total** | **174/174** | — | Across 16 suite files (10 pre-existing + 6 new for Phase 18.2). |
| Real Google/Meta OAuth account | NOT AVAILABLE | — | No live OAuth credentials in this sandbox — see `EXTERNAL_INFRASTRUCTURE.md`. |
| Real Stripe account/webhooks | NOT AVAILABLE | — | Unchanged from Phase 18.1. |
| Flutter mobile compilation | NOT AVAILABLE | — | No Flutter SDK in this sandbox — unchanged from Phase 18.1. |
| Transactional email delivery | NOT AVAILABLE | — | No email provider integrated — unchanged, known gap. |

## Phase 19 Final Test Matrix

Phase 19 re-ran every Phase 18.2 suite plus 4 new ones written for this
phase's required failure/migration testing (`test:worker-crash-reclaim`,
`test:db-migration`, `test:multi-worker-real-process`,
`test:redis-outage-failsafe`), and additionally fired the full CI
pipeline for real against a genuine GitHub Actions runner (not a local
dry-run) three times.

| Test | Result | Environment | Notes |
|---|---|---|---|
| Everything in the Phase 18.2 matrix above | 174/174 | Sandbox | Unchanged, re-verified. |
| Worker-crash job reclaim | 5/5 | Sandbox | `test:worker-crash-reclaim`. Real gap found and fixed this phase. |
| Database migration (fresh + existing DB with real data) | 4/4 | Sandbox | `test:db-migration`. |
| Multi-process worker durability (real hard-kill) | 4/4 | Sandbox, real `worker.js` OS processes | `test:multi-worker-real-process`. |
| Redis-outage fail-safe (real redis-server spawned and killed) | 3/3 | Sandbox, real `redis-server` binary | `test:redis-outage-failsafe`. 2 real gaps found and fixed this phase (liveness hang, stack-trace leak) plus 1 more (rate-limiter fail-open) verified manually but not re-asserted with brittle timing in this suite. |
| **Total (sandbox regression suites)** | **190/190** | — | Across 20 suite files. |
| Real GitHub Actions CI run | PASS, 3/3 real runs (1 failure found+fixed, 2 clean) | Real external service (github.com) | Not a local dry-run — actually fired via `workflow_dispatch` and observed via the GitHub API. Found one real, CI-only bug (an env-var propagation gap) the sandbox alone never would have caught. |
| Real clean-checkout deployment reproducibility | PASS | Sandbox (separate scratch `git clone`) | Checkout → `npm ci` (server+client) → client build → fresh-DB migrate → boot → health check → 24/24 real regression suite, all from nothing but the checkout. |
| Real backup → restore → boot → login cycle | PASS | Sandbox | Not just integrity-check — a real user logs into a real server booted against the restored database. |
| Real load test re-run | PASS, zero errors | Sandbox | See `LOAD_TEST_RESULTS.md` — consistent with the Phase 18.8 numbers. |
| Real outbound webhook delivery to a public endpoint | BLOCKED | — | This sandbox's network egress policy rejects every generic public test endpoint tried; a real staging host should not have this restriction. See `EXTERNAL_INFRASTRUCTURE.md`. |
| Real Google/Meta OAuth account | EXTERNAL SETUP REQUIRED | — | Unchanged. |
| Real Stripe account/webhooks | EXTERNAL SETUP REQUIRED | — | Unchanged. |
| Flutter mobile compilation | EXTERNAL SETUP REQUIRED | — | No Flutter SDK in this sandbox — unchanged. |
| Real hosting / domain | EXTERNAL SETUP REQUIRED / PRODUCTION BLOCKER | — | New this phase — see "Hosting & Real Staging Deployment" above. |

See `PHASE19_NOTES.md` for the full completion report and
`LAUNCH_BLOCKERS.md` for every remaining item prioritized P0-P3.
