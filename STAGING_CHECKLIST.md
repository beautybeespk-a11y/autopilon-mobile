# Staging Environment Checklist

A single checklist to run through when standing up a real staging
environment. Status column uses **PASS** (verified working in this
sandbox, should work in staging too), **FAIL** (a known, real gap — see
notes), or **NOT AVAILABLE** (needs real infrastructure this sandbox
doesn't have; genuinely untested either way).

| Area | Item | Status | Notes |
|---|---|---|---|
| **Application** | Server boots cleanly | PASS | Verified in dev, production-mode, and combined-with-Redis configurations. |
| | Client builds and serves correctly | PASS | Real headless-browser test, zero CSP violations, screenshot-verified rendering. |
| | Env validation refuses unsafe production boot | PASS | Tested both failure and success paths. |
| | `trust proxy` configured for a real reverse proxy | PASS (fixed this phase) | Was a real, silent login-breaking bug until Phase 18.11 — verify this specifically in the real staging topology, don't just trust the fix blindly. |
| **Database** | Schema creates cleanly on a fresh DB | PASS | Real fresh-boot test. |
| | `DB_PATH` override works for a mounted volume | PASS | Tested for real — custom path used, default path untouched. |
| | Backup script runs against a live server | PASS | Real backup, real integrity/row-count verification. |
| | Restore script recovers from real corruption | PASS | Real corrupt-then-restore-then-verify cycle. |
| | Continuous replication (Litestream) | NOT AVAILABLE | Needs a real S3 bucket + sidecar process. |
| **Storage** | Local storage provider | PASS | Existing, working. |
| | S3 storage provider | NOT AVAILABLE | Code is real (existing Phase 14 work) but needs a real bucket to test against. |
| **Queue / Workers** | In-process job processing | PASS | Existing, working, re-verified. |
| | Standalone `worker.js`, multi-process | PASS | Real 2-process test, zero duplication, graceful shutdown verified. |
| | Redis-backed queue provider | NOT AVAILABLE (by design) | Real and independently tested, not wired into the default path — see `jobs/queueProvider.js`. |
| **Redis** | Cache provider | PASS | Real, tested against local `redis-server`. |
| | Rate limiter provider | PASS | Real, tested — including a full regression run with it active. |
| | Session store provider | PASS | Real, tested — including surviving a hard process kill. |
| | Connectivity health check (`/health/redis`) | PASS | Tested in all 3 real states (unconfigured/reachable/unreachable). |
| **Secrets** | `SESSION_SECRET`/`BYOK_ENCRYPTION_KEY` enforcement | PASS | Startup validator refuses a weak/missing value in production. |
| | Secrets never logged | PASS | Structured logger has a redaction safety net; manual review found no secret-logging call sites. |
| | OAuth tokens encrypted at rest | PASS (fixed Phase 18.1) | AES-256-GCM, transparent decrypt-on-read, 27 real assertions. Old plaintext connections from before this fix safely degrade to "please reconnect," never a crash or a garbage token. |
| **OAuth** | Gmail/Google-services OAuth flow (real account) | NOT AVAILABLE | Code-reviewed, CSRF/encryption/revocation all real and tested at the code level, never run against a real Google account. |
| | Meta OAuth flow (real account) | NOT AVAILABLE | Same status as Google. |
| | OAuth revocation on real disconnect (provider side) | PASS (implemented Phase 18.2) / EXTERNAL TEST REQUIRED for the live-provider round trip | Google (`/revoke`) and Meta (`/me/permissions`) both get a real revoke call on disconnect, with a bounded 10s timeout and honest success/failure reporting — verified with 11 real regression checks against a mocked provider boundary (no live Google/Meta account in this sandbox to confirm the real endpoint accepts the call). |
| | Local credentials cleared on disconnect regardless of revocation outcome | PASS | A failed provider-side revocation is never treated as a reason to leave local credentials usable — verified explicitly. |
| | Shopify/WooCommerce/WordPress/WhatsApp revocation | NOT SUPPORTED (inherent to the credential type, not a code gap) | Manual tokens/API keys/application passwords have no revoke call this app can make — see `PHASE18_2_NOTES.md` §3 for the per-provider reasoning. Local credentials are still fully deleted on disconnect. |
| | Cross-org connection isolation | PASS (verified live, Phase 18.2) | 15 real regression checks — personal + 2 orgs' connections for the same provider coexist and are independently readable/disconnectable/reconnectable, including a 3rd unrelated org. |
| | Disconnect-during-refresh race | PASS (found and fixed Phase 18.2) | A refresh in flight when a disconnect lands no longer resurrects the connection with the old refresh token — verified with a real race simulation. |
| | Queued job / worker credential safety | PASS | A job queued before a disconnect, but processed after, fails safely instead of using the stale credential — verified against the real Job Manager. |
| | Cache invalidation | PASS (by construction) | No integration connection or token is ever cached anywhere (in-process or Redis) — every read is a fresh, real, decrypted DB read, confirmed by code audit and a direct regression check. |
| **Webhooks** | Stripe webhook signature verification | PASS | Real code review — Stripe's own SDK, correct. |
| | Stripe webhook idempotency | PASS | Real dedup table, namespaced correctly. |
| | Stripe webhook — actually received a real event | NOT AVAILABLE | No Stripe account in this sandbox. |
| | Developer webhook delivery (Public API) | PASS | Existing Phase 17 work, re-verified passing. |
| **AI Providers** | Provider abstraction / failover | PASS | Existing Phase 16 work, unchanged, re-verified passing. |
| | Real AI provider call | NOT AVAILABLE | No API key configured in this sandbox for any run in this phase. |
| **Billing / sandbox** | Quota/spend-limit enforcement | PASS | Existing Phase 16 work, re-verified in every Phase 18 configuration. |
| | Stripe test-mode checkout | NOT AVAILABLE | No Stripe account. |
| **Email** | Transactional email (invites, password reset) | FAIL (known gap) | No email provider integrated — invited users must be told out-of-band today. |
| **Monitoring** | Structured logging | PASS | Real JSON logs, request-ID correlation verified. |
| | Health checks (liveness/readiness/deep) | PASS | All tested, including real Redis state checks. |
| | External error tracking | NOT AVAILABLE | No service integrated. |
| | External uptime monitoring / alerting | NOT AVAILABLE | No service integrated. |
| **Mobile** | Environment config (`--dart-define`) | REQUIRES TESTING | Code-reviewed, not compiled — no Flutter SDK available. |
| | Session-expiry handling | REQUIRES TESTING | Real gap found and fixed at the code level; not compiled/run. |
| | Push notifications | NOT AVAILABLE | Needs a real Firebase project + device to test delivery. |
| | Platform build (Android/iOS) | FAIL (known gap) | `android/`/`ios/` folders not fully scaffolded; no real build has ever been produced. |
| **Public API** | Auth, scopes, rate limits | PASS | 30/30 regression checks, every Phase 18 configuration. |
| | SDKs (JS + Python) | PASS | Both smoke-tested end-to-end against a live server with a real provisioned API key. |
| | OpenAPI spec validity | PASS | Validated with `openapi-spec-validator`, 39 paths. |
| **Admin** | Access control (session/role checks) | PASS | Fresh DB check every request, no stale-session privilege risk. |
| | Audit logging | PASS | Existing Phase 16 work; confirmed it now correctly survives an org's own deletion (Phase 18.10 fix). |
| **Backups** | Scheduled backup execution | NOT AVAILABLE | The script is real and tested; nothing runs it on a schedule yet — needs a real cron/scheduler in staging. |
| **Security** | Security headers (CSP/HSTS/etc.) | PASS | Real browser-verified, zero violations. |
| | CORS (dev permissive / prod fail-closed) | PASS | Verified both modes via real requests. |
| | Tenant isolation / IDOR / privilege escalation | PASS | 24/24 regression checks, every configuration. |
| | Org/API-key deletion cascades | PASS (fixed across two phases) | Originally found and fixed as a significant data-retention bug (17 orphaned tables including real files on disk); Phase 18.1 found and fixed one more gap this original fix missed (orphaned conversations/messages tied to a deleted org's agents) — both are now covered by real regression tests. |
| | User account self-deletion | NOT IMPLEMENTED | No such feature exists — only org deletion. |
| | CI/CD pipeline | PASS | Every job dry-run locally against this repo before commit. |
| | Docker build | NOT AVAILABLE | Syntax-reviewed + `docker compose config`-validated only; no Docker daemon here. |
| | Load testing | PASS (as a methodology, not a capacity number) | Real measured numbers exist; explicitly not a production capacity claim. |

## Reading this checklist

**PASS** items are safe to trust as-is when standing up staging — they
were genuinely exercised in this environment, not just written and
assumed correct.

**NOT AVAILABLE** items aren't failures — they're things this sandboxed
environment structurally cannot test (no real Stripe account, no real
OAuth credentials, no Docker daemon, no Flutter SDK, no real cloud
infrastructure). Test them for real the first time staging actually has
that infrastructure, using the procedures in `DEPLOYMENT_RUNBOOK.md` and
`PHASE18_10_OAUTH_BILLING_ADMIN_REVIEW.md`.

**FAIL** items are real, known gaps worth fixing before they matter at
scale — none of them block standing up a first staging environment, but
none of them should be forgotten either.
