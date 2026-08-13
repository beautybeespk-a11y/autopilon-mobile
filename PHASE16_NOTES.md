# Phase 16 — Enterprise Scaling, Security & Reliability

Status: complete for everything that can be built and honestly tested inside this
sandbox. Several sub-areas are architecture-only by necessity (no Redis, no real
load-testing infrastructure, no Sentry/Datadog account, no SAML/OIDC identity
provider available here) — those are called out explicitly below, not glossed over.

This phase did **not** rewrite any existing feature. Every change either adds a new,
self-contained abstraction (Job Manager, Rate Limiter, Cache Provider) or wraps an
existing call site (AI provider calls, quota checks, chat) with an additional guard.
Nothing in Phases 1–15 was refactored or replaced.

---

## 1. Architecture Overview

Phase 16 added five new cross-cutting subsystems, all following the same pattern
already established by the AI provider abstractions (`ai/imageProvider.js` etc.):
a `REGISTRY` of named providers, a `configured` flag, and an honest
`PROVIDER_NOT_CONFIGURED` error for anything that needs real infrastructure this
sandbox doesn't have — never a silent fallback that hides a gap.

| Subsystem | File(s) | Real, working adapter | Architecture-only adapter |
|---|---|---|---|
| Job Manager / Queue | `jobs/queueProvider.js`, `jobs/jobManager.js` | In-process (SQLite-backed `jobs` table) | Redis/BullMQ |
| Rate Limiting | `orchestrator/rateLimiter.js` | In-memory fixed-window | Redis |
| Cache | `orchestrator/cacheProvider.js` | In-process `Map` with TTL | Redis |
| AI resilience | `ai/resilientFetch.js` | Real (timeouts, retries, circuit breaker) | — no adapter needed, it's a wrapper |
| Cost controls | `orchestrator/costControls.js`, `orchestrator/costEngine.js` | Real (SQLite `SUM(costCents)`) | — no external service needed |

## 2. Queue / Job Manager Architecture

- `jobs/queueProvider.js`: `InProcessQueueProvider` is real and durable — jobs live
  in the `jobs` SQLite table, so a process restart doesn't lose them — but it is
  **not distributed**: only this one server process claims and runs jobs. That's
  the honest characterization; there is no multi-worker horizontal scaling today.
- `jobs/jobManager.js`: `createJob`, `listJobs`, `cancelJob`, `retryJob`, `pauseJob`,
  `resumeJob`, `processJobsTick`. Exponential backoff (capped at 5 minutes) and
  dead-lettering after `maxAttempts`. Idempotency via an optional `idempotencyKey` —
  a duplicate enqueue with the same key returns the existing job instead of creating
  a second one.
- `RedisQueueProvider` is a named stub with the full method surface, every method
  throwing `PROVIDER_NOT_CONFIGURED`. Switching to it requires installing
  `bullmq`/`ioredis`, implementing the adapter against a real Redis instance, and
  setting `REDIS_URL` + `QUEUE_PROVIDER=redis` — none of which exists in this
  environment.

## 3. Database Improvements

A dedicated audit (background agent, read-only) found 7 missing indexes, 2 N+1
query patterns, and 2 unbounded queries. All were applied and tested against a
live server (Task 34, commit `cea4792`):

- **Indexes added** (9, after further review): `workspace_members(userId)`,
  `conversations(agentId)`, `tool_executions(conversationId)`, `agents(orgId)`,
  `agents(workspaceId)`, `automations(orgId)`, `automations(workspaceId)`,
  `activity_logs(orgId, createdAt)`, `automation_event_queue(userId)`.
- **N+1 fixes**: `marketplace.js`'s `listAssets`/`listMyAssets` now batch-fetch
  every asset's latest version in one query (SQL window function) instead of one
  query per row, and skip the manifest JSON blob list views never render.
  `agentRouter.js`'s `findBestAgent` batch-fetches all candidate agents' skills in
  one query instead of one per agent.
- **Unbounded queries capped**: `list_saved_research` tool (`LIMIT 200`),
  `listAllOrganizations` (`LIMIT`/`OFFSET`, default 200, capped at 500).
- **Deliberately not changed**: `files.js`'s `listFiles` and `contentService.js`'s
  `listAssets` still `SELECT *` including `extractedText`/`textContent`. The audit
  flagged this as worth considering; checking actual client usage showed the file
  preview panel reads `extractedText` straight from the list payload (not a
  separate fetch), so trimming it would have silently broken a working feature.
  Left as-is and documented rather than risking a regression for an optimization
  the audit itself only marked optional.
- New Phase 16 tables (`jobs`, `organization_spend_limits`, `feature_flags`,
  `feature_flag_overrides`) all ship with their own indexes from creation, so
  no separate audit pass was needed for those.

## 4. Security Improvements

**Multi-tenancy audit (Task 29)** — a background agent live-tested the running
app for cross-tenant/IDOR issues rather than just reading code, and found two
real, reproduced vulnerabilities (commit `22a1617`):

1. **Private content template exfiltration (IDOR)** — `templateService.getTemplate(id)`
   had no access check at all, unlike `listTemplates()`. Any authenticated user
   could read any other org's private template by id. Fixed by adding a `userId`
   parameter and enforcing the same visibility rule `listTemplates()` already used.
2. **Comments had no per-entity access control (IDOR, read + write)** —
   `comments.js` validated comment content but never whether the caller could
   access the entity (agent/project/file/task/content) being commented on. Any
   authenticated user could read and write comments on any entity. Fixed with an
   entity-type → access-check dispatch that reuses each subsystem's own
   `canAccess*()` function; an unknown entity type is denied by default.

Both were reproduced against a live server *before* the fix (confirmed exploitable)
and reproduced again *after* (confirmed blocked, 403/404) — not just patched blind.

**Webhook security (Task 36)** — Stripe webhook processing had no event-id dedup
(WhatsApp and Shopify already had it). Extracted the shared `isDuplicateEvent()`
helper into `orchestrator/webhookDedup.js` and wired it into
`routes/stripeWebhook.js`; a redelivered Stripe event now short-circuits instead of
re-processing. Verified function-level (Stripe requires a real signing secret to
test over real HTTP, which this sandbox doesn't have) and via the regression suite.

**Chat pipeline billing/quota bypass (Task 38)** — the single biggest gap found
this phase: `orchestrator/index.js`'s `orchestrate()` (used by web chat, mobile
chat, and WhatsApp) had **zero** quota enforcement and **zero** usage/cost
recording, unlike every other AI generation surface in the app. Fixed by adding
`enforceQuota`/`enforceSpendLimit`/`recordAiTextUsage` calls before and after the
model call. While building and testing this, found and fixed a second real bug:
`orchestrate()` resolved the billing org via `resolveOrgId(userId)` (the user's
*first-joined* org), so a user who belongs to multiple orgs and chats through an
org-B agent would have been billed/blocked against org A. Fixed to resolve from
the agent's own `orgId` first. Both confirmed live: cross-org billing isolation
now holds, verified with two real orgs and two real agents.

**Security regression suite (Task 39, commit `ac58bb2`)** — see §13.

## 5. Monitoring / Observability

`routes/health.js`:
- `GET /api/health/live`, `/ready` — public, minimal, for infra probes.
- `GET /api/health/database`, `/queue`, `/storage`, `/ai`, `/integrations` — each
  gated behind `requireAuth + requirePlatformAdmin`; `/queue` does a **real**
  end-to-end check (enqueues a job, processes it, verifies completion), not just a
  status flag.
- `GET /api/health` — a one-request rollup of everything above, also
  platform-admin-gated. **Found and fixed a real bug while extending this route
  this phase**: a leftover `app.get("/api/health", ...)` handler in `index.js`,
  registered before the full router mount, was silently shadowing this rollup for
  every caller — it had been dead code since Task 35 shipped. Removed the shadow;
  the rollup (now including cache status) is correctly reachable and correctly
  gated.
- AI provider status includes live circuit-breaker state (`closed`/`open`/`half_open`)
  per provider, not just "configured y/n".

## 6. Logging

Existing `activity_logs` table (pre-Phase-16) continues to be the audit trail for
user-facing actions; Phase 16 additions (`spend_limits_updated`,
`maintenance_mode_changed`, flag changes, plan changes) all log through the same
`logActivity()` helper — no new logging system was introduced, per the spec's
instruction to reuse existing systems rather than rewrite them.

**Not implemented**: structured/centralized log shipping (to something like
CloudWatch or a log aggregator) — this sandbox has no such destination configured.
`console.log`/`console.error` plus the DB-backed activity log is the current,
honest state.

## 7. Alerting

Real, working, in-app: quota threshold warnings (`billing.js`'s `maybeWarnQuota`,
pre-existing) and the new spend-limit threshold alerts (`costControls.js`'s
`maybeAlert`) both create real in-app notifications via the existing
`createNotification()` system, deduped per (org, scope, day) so a threshold only
fires once. Verified live: crossing a configured spend limit produces exactly one
notification, not one per request.

**Not implemented**: external alerting (PagerDuty, Slack webhook alerts, email
digests) or an error-tracking service (Sentry/Datadog). No such account or API key
is available in this environment. The circuit-breaker state exposed in
`/api/health/ai` is the closest thing to "is something broken right now" that
exists today, and it requires a human (or an external monitor) to poll it — there
is no push-based paging.

## 8. Backup Strategy

**Not implemented, and cannot be, inside this sandbox.** The database is a local
SQLite file (`server/app.sqlite`); there is no automated backup/snapshot job, and
building one meaningfully requires a real deployment target (a persistent volume,
a cloud provider's snapshot API, or a managed Postgres/MySQL with point-in-time
recovery) that doesn't exist here. This is flagged honestly rather than faked with
a script that writes a backup file nobody would actually restore from in
production.

## 9. Disaster Recovery

Same constraint as backups — a real DR plan requires a real second environment/region
to fail over to, which this sandbox cannot provide. What *is* true today: SQLite's
WAL mode gives crash-safety for the running process, and the Job Manager's
durability (jobs survive a process restart) means a server restart doesn't lose
queued/in-flight work. That is not disaster recovery; it's process-restart safety,
and the report calls it that rather than overselling it.

## 10. Rate Limiting

`orchestrator/rateLimiter.js` — `InMemoryRateLimiter`, fixed-window counters swept
periodically, plus a separate concurrency counter (in-flight request count, not a
time window). Real and tested:

- Global: 300 req/min per IP across all `/api` traffic (`index.js`).
- Auth: 10 req/min per IP on `/api/auth/*` (brute-force protection).
- AI burst: per-org, plan-derived limits (`aiBurstLimitForOrg`) plus a per-user
  concurrency cap (`AI_MAX_CONCURRENT_PER_USER`) applied to chat, content
  generation, and voice endpoints.

A `RedisRateLimiter` stub exists for a real multi-process deployment (the
in-memory limiter's counters are per-process, so they under-count across more than
one server instance) — architecture-only, same `PROVIDER_NOT_CONFIGURED` pattern.

## 11. Caching

`orchestrator/cacheProvider.js` (Task 40, commit `90cff64`) — see the file itself
for the full rationale. Applied to three hot-path reads, not blanket-applied
everywhere (correctness-sensitive reads like usage counters and spend totals are
deliberately never cached):

- `maintenanceMode.js`'s `maintenanceStatus()` — checked on every request, 5s TTL,
  invalidated immediately on write.
- `billing.js`'s `getPlan()` — read on every quota check, 60s TTL, invalidated on
  `updatePlan()`.
- `featureFlags.js`'s `isFeatureEnabled()` — flag + override list cached as one
  unit, invalidated on every flag/override write.

Verified live: cache hits serve correctly until TTL or explicit invalidation;
maintenance mode toggling on/off takes effect immediately (no stale 200s during an
active maintenance window); TTL expiry recomputes correctly.

## 12. Feature Flags

`orchestrator/featureFlags.js` — three-layer resolution (per-user override →
per-org override → global enabled + deterministic MD5-hash rollout bucketing, so
the same user/org always lands on the same side of a rollout percentage). An
unknown flag key is always `false`. Admin CRUD + override management exposed under
`/api/admin` (platform-admin-gated). `disableFlag()` is a one-call kill switch,
separate from the general update, so an emergency disable reads unambiguously in
the audit log.

## 13. Testing Results

**Method**: no test framework was previously installed in this project, so Phase
16 testing followed the same approach used throughout — direct `node --check` for
syntax, then real HTTP requests against a locally-booted server, with DB fixtures
for setup and explicit cleanup after every run. `server/test/securityRegression.js`
(new, Task 39) is a proper, repeatable, runnable script (`npm run test:security`),
not a one-off manual session.

**Security regression suite — 20/20 checks passing** (verified repeatable, ran
twice with identical results):
- Session abuse (2): no cookie / forged cookie → 401.
- IDOR (4): cross-user agent, conversation, file, and delete access all denied,
  no data leaked.
- Cross-tenant access (5): non-member reads of org members / spend limits / cost
  breakdown / BYOK keys / spend-limit writes all denied (403).
- Privilege escalation (5): a plain "member" role cannot invite members,
  self-promote to owner, or set the billing plan; a non-platform-admin cannot list
  all orgs or flip maintenance mode.
- Billing/quota bypass (2): chat blocked once an org's spend limit is hit; one
  org's chat can never be billed against a different org.
- Webhook replay (1): same event id processed exactly once.
- API key exposure (1): saved BYOK keys never appear in plaintext in any response.

**Also manually tested this phase** (each against a live booted server, with
cleanup after): Job Manager enqueue/claim/complete/fail/retry/dead-letter cycle;
rate limiter window behavior and concurrency double-release fix; circuit breaker
open/half-open/close transitions; health endpoint auth gating; cost-control
enforcement and no-op path; all 9 new DB indexes present and queries returning
correct results after the N+1/LIMIT fixes; cache TTL expiry and invalidation.

## 14. Security Findings

**Fixed this phase** (see §4 for detail): private template IDOR, comments IDOR,
missing Stripe webhook dedup, chat pipeline billing/quota bypass, chat pipeline
cross-org billing misattribution.

**Found, documented, deliberately left as-is** (low severity):
`files.js`'s `GET /:id` returns `403 Forbidden` for "exists but you can't access
it," while `agents`/`conversations` collapse both "doesn't exist" and "exists but
forbidden" into a generic `404` specifically to avoid confirming a resource's
existence to an unauthorized caller. This is a real inconsistency across the
codebase's permission patterns — a stranger probing file ids can distinguish
"never existed" from "exists, not yours" via status code alone. Severity is low:
file ids are `cryptoRandom()`-generated (unguessable, not sequential), so this
doesn't enable practical enumeration, and no file *data* is ever returned to a
non-owner (verified in the regression suite). Fixing it properly means
distinguishing "zero relationship to this file" from "some relationship but
insufficient permission" in `canAccessFile`, which risks changing legitimate
sharing-flow UX (e.g. a workspace member should see a real 403, not a confusing
404, for a file they can see but can't edit) — left as a documented finding
rather than risking that regression under this phase's time budget.

**Not assessed this phase** (out of scope, would need dedicated passes):
CSRF protection posture, CORS configuration review, security headers
(CSP/HSTS/etc.), dependency vulnerability scanning, secrets-at-rest review beyond
what BYOK encryption already does.

## 15. Performance Findings

No real load test was run — see §16. What was verified is *correctness under
concurrency* (the double-release bug in the concurrency limiter, caught in
self-review before shipping) and the concrete DB-level fixes in §3. There is no
throughput number (requests/sec, p95 latency) to report, because generating one
honestly requires load-testing infrastructure this sandbox doesn't have.

## 16. Known Limitations

- Queue, rate limiter, and cache are all **single-process** — the in-process
  adapters are correct and durable (queue) or effective (rate limiter, cache)
  for exactly one running server instance. Running more than one instance
  (horizontal scaling) requires the Redis adapters, which are architecture-only.
- No real load testing was performed or could be performed here — no load-testing
  tool, no staging environment, no realistic traffic generator available.
- No backup/disaster-recovery mechanism exists (§8, §9) — requires a real
  deployment target.
- No external error tracking, alerting, or log aggregation (§6, §7) — requires
  external accounts/services not present here.
- Enterprise SSO (SAML/OIDC) is not implemented — no identity provider available
  to build or test against; would need to be scoped as its own phase.
- The file-permission status-code inconsistency in §14 remains, by deliberate
  choice, documented rather than fixed.

## 17. External Infrastructure Required (to move past architecture-only)

| Capability | Needs |
|---|---|
| Distributed queue | Redis instance + `REDIS_URL`, `bullmq`/`ioredis` packages, `QUEUE_PROVIDER=redis` |
| Distributed rate limiting | Redis instance, same as above, `RATE_LIMIT_PROVIDER=redis` |
| Distributed cache | Redis instance, same as above, `CACHE_PROVIDER=redis` |
| Error tracking / alerting | Sentry or Datadog account + API key |
| Log aggregation | CloudWatch, or any log-shipping destination |
| Backups / DR | A real deployment target with snapshot/PITR capability (managed Postgres/MySQL, or a cloud provider's volume-snapshot API) |
| Enterprise SSO | A SAML or OIDC identity provider to integrate against |
| Load testing | A load-testing tool (k6, Artillery, etc.) and a staging environment safe to hammer |

## 18. Production Readiness Assessment

**Honest assessment, not a blanket "production-ready" claim**: the application is
considerably more resilient and secure than before this phase — real quota/spend
enforcement now covers every AI generation path (previously chat had none at all),
two real cross-tenant vulnerabilities are fixed and regression-tested, AI provider
calls have real timeouts/retries/circuit breakers instead of hanging forever, and
a real (if manual-trigger) security regression suite exists and passes.

It is **not** production-ready in the sense of "deploy this at scale today and
walk away." Specifically: it has never run under real concurrent load; it has no
backup or disaster-recovery capability; it runs as a single process with no
horizontal scaling path until Redis is added; and it has no external monitoring
that would page a human if something breaks outside of business hours. Those are
infrastructure gaps, not code gaps — the code is written to slot a real Redis
instance and real observability tooling in without further application changes,
but until that infrastructure exists, this is a solid single-instance deployment
with real security and billing correctness, not an enterprise-scale production
system.
