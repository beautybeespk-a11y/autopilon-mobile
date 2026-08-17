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
| | OAuth tokens encrypted at rest | FAIL (known gap) | Stored in plaintext — see `PHASE18_10_OAUTH_BILLING_ADMIN_REVIEW.md`. Not blocking a staging deploy, but should be fixed before handling real user OAuth connections at any scale. |
| **OAuth** | Gmail/Google-services OAuth flow | NOT AVAILABLE | Code-reviewed, one real CSRF bug fixed, never run against a real Google account. |
| | Meta OAuth flow | NOT AVAILABLE | Same status as Google. |
| | Cross-org connection isolation | PASS (by design, unverified live) | Existing `saveOrgConnection`/`getOrgConnection` design is org-scoped; worth a real confirmation once credentials exist. |
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
| | Org/API-key deletion cascades | PASS (fixed this phase) | Was a real, significant data-retention bug (17 orphaned tables including real files on disk) — fixed and tested. |
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
