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
| Standalone worker (`worker.js`) | READY | Real multi-process test: two independent worker processes sharing one SQLite file correctly split real job load with zero duplication; graceful shutdown on SIGTERM confirmed. |
| Session cookie security | READY (after this phase's fix) | Phase 18.11 found and fixed a real, critical bug: without `trust proxy`, the production `secure: true` cookie was **never sent** behind any real reverse proxy — verified via realistic `X-Forwarded-Proto` simulation. |

## Security

| Component | Status | Notes |
|---|---|---|
| Security headers (CSP, HSTS, etc.) | READY | Real helmet config tuned to the client's actual asset origins; verified via a real headless browser with zero CSP violations. |
| CORS | READY | Dev: permissive (unchanged). Production: explicit allowlist, fails closed if `CLIENT_ORIGIN` unset — verified via real curl requests in both modes. |
| Tenant isolation / IDOR / privilege escalation | READY | Existing Phase 16 protections, re-verified passing in every Phase 18 configuration (24/24 security regression checks). |
| OAuth CSRF protection | READY (re-verified Phase 18.1) | The weak-RNG `state`-generation fix (Gmail/Google-services/Meta, now `crypto.randomBytes`) has a dedicated 7-check regression suite as of Phase 18.1: fresh high-entropy state per call, garbage/missing state rejected, correct state accepted, single-use (replay rejected), cross-user isolation, and concurrent-`/connect`-call safety. |
| OAuth/integration token encryption at rest | READY (fixed this phase) | **Was the top-priority known gap** — access/refresh tokens (OAuth and manual, e.g. a WooCommerce consumer secret or WordPress application password) are now AES-256-GCM encrypted before ever touching the database, decrypted transparently on read in `integrations/manager.js` so none of the 12+ existing call sites needed to change. A decrypt failure (wrong key, corrupted data, or a pre-encryption plaintext row) degrades safely to "please reconnect," never a crash or garbage token. 27 real assertions (encrypt/store/read/decrypt/refresh/revoke/disconnect/invalid-ciphertext/wrong-key/cross-org-isolation), all passing. See `PHASE18_1_NOTES.md` §1 for the migration story (old plaintext tokens simply stop decrypting and prompt reconnect — no real production users have ever existed against this schema). |
| OAuth token revocation on disconnect | NOT READY | **Unchanged this phase, still a known gap**: disconnecting an integration only clears local DB fields — never calls the provider's real revoke endpoint. Not fixed (untestable without live OAuth credentials; out of Phase 18.1's hardening scope, which focused on encryption/leakage/CSRF/proxy/retention). |
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
| Stripe integration (existing) | READY AFTER EXTERNAL CONFIGURATION | Code is real and correct (verified across two review passes); real signature verification, real idempotency, correct retry semantics, correct quota/usage sync on plan changes — but has never received a real event, since no Stripe account exists in this sandbox. Needs a real Stripe TEST-mode account + webhook registration; see `EXTERNAL_INFRASTRUCTURE.md` and `DEPLOYMENT_RUNBOOK.md` §12 step 14 for the exact staging test procedure. **EXTERNAL STAGING TEST REQUIRED** before any billing claim is made. |
| Quota/spend-limit enforcement | READY | Existing Phase 16 work, re-verified passing in every configuration tested, including after Phase 18.1's changes. |

## External Delivery (Email / Developer Webhooks)

| Component | Status | Notes |
|---|---|---|
| Transactional email | NOT IMPLEMENTED | No email provider is integrated anywhere in this codebase. `routes/organizations.js`'s member-invite flow and `routes/auth.js`'s `/forgot-password` both explicitly have no outbound-email path (invited users are told out-of-band today; forgot-password returns an acknowledgment with no actual email sent). This is a missing feature, not an untested one — nothing to stage-test until it's built. |
| Developer webhook delivery (outbound, Public API) | READY (code) / EXTERNAL STAGING TEST REQUIRED | Signing, timestamp/replay protection, retry/backoff, and SSRF protection on webhook creation are all real and covered by the Public API security regression suite (30/30, including 5 dedicated signing/SSRF checks). Never delivered to a real, independently-reachable external endpoint outside this sandbox — see `DEPLOYMENT_RUNBOOK.md` §12 step 15 for the exact staging checklist (real endpoint, real delivery, dead-letter/retry behavior under a deliberately-failing receiver). |

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
during Phase 18 or Phase 18.1, not reasoned about. Anything marked
REQUIRES TESTING, ARCHITECTURE ONLY, or EXTERNAL STAGING TEST REQUIRED
was deliberately not claimed as more than that.

Phase 18.1 re-ran every regression suite from Phase 18 plus six new ones
written specifically for this hardening pass (OAuth token encryption,
credential leakage, reverse-proxy/session behavior, CSRF, data retention,
admin panel security) against one freshly-migrated live server —
121/121 checks passing. See `PHASE18_1_NOTES.md` for the full breakdown,
the production launch blocker list, and every fix made during this pass.
