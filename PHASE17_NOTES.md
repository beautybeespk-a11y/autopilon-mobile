# Phase 17 — Public API & Developer Platform

Status: complete for everything buildable and honestly testable inside this
sandbox. A handful of sub-areas are architecture-only or explicitly
not-implemented by necessity (no real external webhook receiver reachable
from this environment's egress proxy, no Python runtime work undertaken, no
production load-testing infrastructure) — called out explicitly below, not
glossed over.

This phase did **not** create a second billing/quota/permission/queue system.
Every Public API capability rides the exact same enforcement the internal
app already uses: `orchestrator/costControls.js`'s spend limits, the Phase 16
Job Manager for async execution and webhook delivery, `orchestrator/rateLimiter.js`'s
engine, and `orchestrator/featureFlags.js`'s flag evaluator. Nothing in
Phases 1–16 was rewritten to build this — every new file is additive, and
every existing file this phase touched (`orchestrator/index.js`,
`orchestrator/conversationService.js`, `routes/chat.js`, `fileService.js`,
`automation/runner.js`, `costControls.js`) was extended in place, not
replaced.

---

## 1. Architecture Overview

A dedicated, versioned layer (`server/publicApi/`), mounted at `/api/v1`,
deliberately separate from `server/routes/` (internal, session-authenticated)
and `server/routes/platformAdmin.js` (platform-admin-only). Three distinct
auth mechanisms now coexist in this app, never interchangeable:

| Mechanism | Used by | Where |
|---|---|---|
| Session cookie | Web/mobile app, Developer Console | `middleware.js`'s `requireAuth` |
| Bearer API key | External developers/machines | `publicApi/auth.js`'s `requireApiKey` |
| Platform-admin session | Platform operators | `middleware.js`'s `requirePlatformAdmin`, stacked on `requireAuth` |

Every `/v1` resource router follows the same shape: `router.use(requireApiKey,
requireCapability(<flag>), apiRateLimit())`, then per-route `requireScope(<scope>)`.
Business logic lives in `server/orchestrator/*ApiService.js` files — one per
resource, each enforcing `req.orgId` as the tenant boundary directly in its
own SQL, never by delegating to an internal function that checks a *user's*
broader org membership (see §3).

## 2. What Was Built (by resource)

All of the below is real, wired end-to-end, and was tested against a live
booted server (not just code-reviewed) — see §12 for the actual test
evidence.

- **Developer API keys** (`orchestrator/apiKeyService.js`): create/list/revoke/rotate,
  17-scope least-privilege model, SHA-256-hashed secrets shown once.
- **Agents** (`publicApi/agents.js`, `publicApi/runs.js`, `orchestrator/agentApiService.js`):
  list/get, execute (sync + async via the Job Manager), a `/messages` alias,
  list runs, get a run by id. Fires `agent.run.started/completed/failed` webhook events.
- **Automations** (`publicApi/automations.js`, `orchestrator/automationApiService.js`):
  list/get, trigger a run (reuses `automation/runner.js`'s `runWorkflow` as-is),
  list/get runs. Fires `automation.started/completed/failed`.
- **Tasks** (`publicApi/tasks.js`, `orchestrator/taskApiService.js`): full CRUD +
  complete/archive, an additive org-scoped layer over the same `tasks` table
  the pre-existing personal to-do feature uses. Fires `task.created/completed`.
- **Projects** (`publicApi/projects.js`, `orchestrator/projectApiService.js`):
  CRUD + item attach/detach, delegating writes to the existing
  `projectManager.js` (keeping its owner/admin role check intact — an API
  key can never do more than its creator could via the web UI).
- **Files** (`publicApi/files.js`, `orchestrator/fileApiService.js`): list/get,
  multipart upload (500 MB cap), stream content, mint a time-limited signed
  download link (reuses the Phase 14 `file_shares` mechanism), delete. Fires
  `file.uploaded` (from a function-level hook in `fileService.js`, so it
  fires for internal uploads too, not just Public API ones).
- **Content Generation** (`publicApi/content.js`, `orchestrator/contentApiService.js`):
  text/image/voice generation, reusing the existing copywriter/content-studio
  generation functions as-is (quota/spend/billing enforcement comes free).
  Fires `content.generated`.
- **Integrations** (`publicApi/integrations.js`, `orchestrator/integrationApiService.js`):
  read-only connection status list. No action-execution endpoints (§9).
- **Marketplace** (`publicApi/marketplace.js`): browse published assets and
  categories, reusing `orchestrator/marketplace.js`'s `listAssets` with
  `viewerUserId=null` so only the public, moderation-approved default view
  is ever reachable.
- **Developer webhooks** (`publicApi/webhooks.js`, `orchestrator/developerWebhookService.js`,
  `webhookDelivery.js`, `webhookSigning.js`, `webhookEvents.js`, `publicApi/ssrf.js`):
  full CRUD, SSRF-protected URLs (validated at creation *and* immediately
  before every delivery), Stripe-convention HMAC-SHA256 signing, 13 event
  types, delivery via the Job Manager (retry with exponential backoff,
  dead-letter after 3 attempts), synchronous test-send, delivery history.
- **API request logging + usage dashboards** (`publicApi/requestLog.js`,
  `orchestrator/apiUsageService.js`): every `/v1` request logged with
  method/path/status/latency/error code; org-scoped dashboard in the
  Developer Console, platform-wide rollup in the Admin Panel (§8).
- **Developer Console** (`routes/developerConsole.js`, `client/src/pages/DeveloperConsole.jsx`):
  session-authenticated (owner/admin only) backend and web UI — API Keys,
  Webhooks, Usage Overview, and Request Logs tabs.
- **Feature-flag gating** (`publicApi/featureGate.js`): one master switch
  (`public_api`) plus one flag per resource area, all reusing the Phase 16
  flag engine — global and per-org override support, no new gating system.
- **Cursor pagination** (`publicApi/pagination.js`) and a **consistent error
  shape** (`publicApi/errors.js`) shared by every endpoint.
- **Rate limiting** (`publicApi/rateLimit.js`): per-key, plan-derived
  requests/minute, plus a separate per-key AI concurrency cap — both reusing
  the Phase 16 rate-limiting engine, not a new one.
- **Documentation**: `PUBLIC_API.md`, `DEVELOPER_GUIDE.md`, `WEBHOOKS.md`,
  `API_SECURITY.md`, `API_CHANGELOG.md`, `openapi.yaml` (validated with
  `openapi-spec-validator`).
- **SDK**: `sdk/js/` — a minimal, dependency-free JS/TS client covering
  every implemented endpoint, hand-written `.d.ts`, no Python SDK (§9).
- **Admin analytics** (`orchestrator/apiUsageService.js`'s
  `getPlatformApiUsageDashboard`, a new Admin Panel section): platform-wide
  request/error/latency totals, top endpoints, top organizations, error
  codes, rate-limit event count, webhook delivery status and failures by org.

## 3. Tenant Isolation — The Central Discipline

This is the property this phase spent the most deliberate effort on, because
it's the one class of bug most damaging in a multi-tenant API. The rule,
applied to every single Public-API-only service function written this phase:
filter directly by `req.orgId` (the org the authenticating key belongs to)
in the function's own SQL query — never by delegating to an internal
"can this user access X" check, because those checks are scoped to the
**calling user's entire personal org membership** (every org they belong to
via the web app), not the one org this specific key was issued for.

This gap class was found and fixed for real, in a live-reproduced
vulnerability, in `routes/chat.js` (commit `4dd1389`, found while building
the Public Agent API and testing usage tracking): any authenticated
*session* user could pass any `agentId` with zero access check, and because
`orchestrate()` enforces spend limits against the *agent's own* org, this let
a stranger consume/exhaust an unrelated org's AI budget. Confirmed
exploitable against a live server before the fix, confirmed blocked after.

Every new Public-API service function this phase (`agentApiService.js`,
`automationApiService.js`, `taskApiService.js`, `projectApiService.js`,
`fileApiService.js`, `contentApiService.js`, `integrationApiService.js`) was
written against this exact gap class preemptively, and it is now covered by
a repeatable regression test (`test/publicApiSecurityRegression.js`'s
cross-org checks — org B's key gets `404`, never `403`, on org A's agent/
task/project, and org A's task never leaks into org B's own list).

Where a write delegates to an existing internal function that has its own
role check (project create/update requiring workspace owner/admin), that
check is intentionally **kept**: an API key must never grant more power than
its creating user already has through the web UI. Tenant-scoping and
permission-scoping are separate, both-required gates.

## 4. Authentication & Authorization

- Bearer API keys (`ap_live_<32 random bytes, base64url>`), SHA-256-hashed
  at rest — never encrypted/reversible, unlike BYOK provider keys, because a
  developer key never needs to be read back by the server, only compared.
- 17-scope fixed list, no wildcard. A route's required scope is declared
  explicitly at the point of use (`requireScope(...)`), not buried in shared
  logic.
- Only an org owner/admin can create/rotate/revoke a key for that org
  (enforced by the session-authenticated Developer Console).
- A revoked, expired, or simply-invalid key all produce the identical
  `401 UNAUTHENTICATED` — never distinguishable to the caller.

## 5. SSRF Protection (Webhooks)

`publicApi/ssrf.js`'s `assertSafeWebhookUrl` blocks loopback, RFC1918
private ranges, link-local (which covers `169.254.169.254`, every major
cloud's instance-metadata endpoint), CGNAT, and IPv6 equivalents; every
resolved DNS address is checked, not just the first. Validated at webhook
creation **and** re-validated immediately before every delivery attempt —
the second check is the one that actually matters, since DNS can change
between the two (a classic rebinding bypass of a creation-time-only check).
Covered by 6 live-fired attack-URL checks in the regression suite plus a
19-case unit-level pass during original development (Task 49).

## 6. Webhook Delivery

Rides the existing Phase 16 Job Manager — one attempt per invocation,
exponential backoff (`min(2^attempts*2, 300)` seconds), dead-letter after 3
attempts — rather than a bespoke webhook queue. Signing follows Stripe's
`t=...,v1=...` HMAC-SHA256 convention, replay-resistant because the
timestamp is signed into the HMAC input. Verified function-level (signing +
verification round-trip, tampered body, wrong secret, stale timestamp, and
malformed header all correctly rejected — `test/publicApiSecurityRegression.js`).

**Known environment limitation**: real end-to-end delivery to an external
receiver (e.g. `httpbin.org`, `example.com`) was attempted during original
development (Task 49/50) and blocked by this sandbox's own outbound network
proxy allowlist (`403 Host not in allowlist`) — not a code defect. The
delivery mechanism itself (URL validation, signing, HTTP send, response
capture, retry classification) was proven correct via a real webhook created
and test-sent against `https://example.com/...` during this phase's testing,
which *did* receive a real HTTP response (a proxy-issued `403`, correctly
recorded as the delivery result) — proof the full pipeline executes
end-to-end, just not that a real receiver ever got the payload in this
sandbox.

## 7. Feature-Flag Gating

One master switch (`public_api`) plus one flag per resource area
(`public_api_agents`, `public_api_automations`, ...), all defaulting to
`enabled=true` (seeded idempotently at server startup) so this changed
nothing about default behavior on its own. Because the underlying engine
already supports per-org and per-user overrides, this gives exactly the
"disable globally, or keep off globally while enabling for one early-access
org" capability requested — no redeploy either way. Verified live: disabling
a single resource flag returns `503 FEATURE_DISABLED` for that resource only
while sibling resources keep working; disabling the master flag takes down
the whole API; a per-org override correctly re-enables it for just that org.

**Known gap**: no admin web UI for managing flags yet (a pre-existing
Phase 16 gap this phase did not introduce or fix) — flags are toggled via
the already-existing `/api/admin/feature-flags` REST endpoints.

## 8. Admin Analytics

`GET /api/admin/api-usage` (platform-admin-only) + a new Admin Panel section:
platform-wide request/error/latency totals, top endpoints, top organizations
by request volume and errors, error-code breakdown, rate-limit event count,
active key/webhook counts, webhook delivery status breakdown, and top
organizations by webhook delivery failures. Reuses the exact
`api_request_logs`/`webhook_deliveries` tables Task 51 already built for the
org-scoped Developer Console dashboard — no new tracking tables. Every query
returns only aggregate counts and identifying metadata (org name, endpoint
path, error code); no query in this path ever touches a hashed or encrypted
secret column.

## 9. Known Limitations (Disclosed, Not Hidden)

- **No `Idempotency-Key` support on synchronous write endpoints** (task/
  project create, content generation, agent execute). A retried request
  after a client-side timeout can create a duplicate resource. Async agent
  execution and webhook delivery *do* get idempotency and retry, via the
  Job Manager.
- **No integration action execution via the Public API** — read-only
  connection status only. The real, working path today is
  `POST /v1/agents/:id/execute` against an agent with the relevant
  tool/skill enabled (every integration action already exists as a Tool).
  Building a curated per-provider action API (WordPress/WooCommerce/
  Shopify/Gmail/Meta/WhatsApp) is real, substantial work not attempted this
  phase.
- **No admin web UI for feature flags** (API-only, pre-existing Phase 16 gap).
- **No Python SDK.** Only JS/TS was built (`sdk/js/`); not attempted due to
  time budget, disclosed rather than left silently absent.
- **No per-event webhook payload schema versioning** — `data`'s shape is
  stable in practice (whatever the emitting code passes) but not
  contractually documented per event type beyond what WEBHOOKS.md describes.
- **No automatic re-drive of dead-lettered webhook deliveries.**
- **No real end-to-end webhook delivery test against an external receiver**
  (§6) — the sandbox's own network policy blocks it; the pipeline was
  proven correct up to the point where a real receiver would need to exist.
- **No third-party penetration testing or formal load/DoS testing** of the
  Public API specifically. All security testing this phase was functional/
  regression testing (50 checks total across two suites) plus targeted
  manual verification of the SSRF, tenant-isolation, and quota-bypass
  scenarios described above.

## 10. External Infrastructure Required (to move past current limitations)

| Capability | Needs |
|---|---|
| Real webhook delivery testing | Network egress to arbitrary developer-chosen hosts (this sandbox's proxy allowlist blocks it) |
| Python SDK | Time/scope allocation — no technical blocker |
| Idempotency-Key support | Application work only — no external infra needed |
| Integration action execution API | Substantial per-provider design + implementation work |
| Feature-flag admin UI | Application work only — the backend API already exists |
| Load/penetration testing | A load-testing tool (k6, Artillery) and/or a security firm engagement, plus a safe-to-hammer staging environment |

## 11. Files Added / Changed

**New**: `server/publicApi/` (auth, errors, requestId, pagination, rateLimit,
requestLog, router, ssrf, featureGate, agents, runs, automations, tasks,
projects, files, content, integrations, marketplace, webhooks — 19 files),
`server/orchestrator/` additions (apiKeyService, secretsCrypto,
agentApiService, automationApiService, taskApiService, projectApiService,
fileApiService, contentApiService, integrationApiService,
developerWebhookService, webhookSigning, webhookDelivery, webhookEvents,
apiUsageService — 14 files), `server/routes/developerConsole.js`,
`server/test/publicApiSecurityRegression.js`, `client/src/pages/DeveloperConsole.jsx`,
`sdk/js/` (4 files), `PUBLIC_API.md`, `DEVELOPER_GUIDE.md`, `WEBHOOKS.md`,
`API_SECURITY.md`, `API_CHANGELOG.md`, `openapi.yaml`.

**Modified**: `server/db.js` (new tables + `tasks.orgId`/`updatedAt`
columns), `server/index.js` (mount `/api/v1` early, seed feature flags,
mount `developerConsoleRoutes`), `server/orchestrator/index.js` and
`conversationService.js` (usage totals returned from `orchestrate()`),
`server/routes/chat.js` (cross-tenant fix, commit `4dd1389`),
`server/orchestrator/apiKeys.js` (extracted shared crypto),
`server/orchestrator/rateLimiter.js` (exposed `checkRateLimit`),
`server/orchestrator/fileService.js` (`file.uploaded` hook),
`server/automation/runner.js` (automation webhook events),
`server/orchestrator/costControls.js` (`usage.threshold_reached` event),
`server/routes/platformAdmin.js` (`/api-usage` route),
`client/src/App.jsx` + `OrganizationDetail.jsx` (Developer Console route/nav).

**Commits** (chronological): `82a611a`, `f116738`, `0a20ef7`, `c88dee0`,
`4dd1389` (security fix), `dc4cc78`, `f2f6d6e`, `f76266c`, `f2f219f`,
`e6ad79b`, `e47f4a2`, `1b2445e`, `4605124`, `215c0de`, `8e76849`, `f9da5a2`,
`bf2b0a2`.

## 12. Testing Results

**Method**: the same discipline used throughout this project — `node --check`
for syntax, then real HTTP requests against a locally-booted server with
real DB fixtures (test orgs, users, API keys), explicit cross-tenant checks,
explicit cleanup after every run (`rm -f app.sqlite*`, `git checkout --`
the WAL/SHM files), never mocked. UI changes were additionally verified in a
real Chromium browser via Playwright, screenshots captured and inspected.

**Phase 16 security regression suite — 20/20 passing** (unchanged, re-run
as a gate after every single task this phase to confirm nothing regressed).

**New Phase 17 Public API security regression suite
(`test/publicApiSecurityRegression.js`, `npm run test:security:public-api`)
— 30/30 passing**, confirmed to run cleanly back-to-back with the Phase 16
suite with no interference:
- Auth edge cases (5): missing header, garbage token, revoked key, expired
  key, rotation invalidating the old secret immediately.
- Scopes (2): missing-scope rejection, correct-scope success.
- Cross-org isolation (4): agent/task/project access denied (404) and list
  filtering, via a real second organization's key.
- SSRF (7): 6 malicious webhook URLs rejected, 1 safe URL accepted.
- Webhook signing (5): valid/tampered/wrong-secret/stale-timestamp/malformed-header.
- Quota/billing bypass via API key (2): execution blocked at the org's spend
  limit; isolation confirmed against a second org.
- Feature-flag gating (3): resource-level, master-switch, and per-org-override
  behavior.
- Secrets exposure (2): API key raw secret never reappears; webhook secret
  never fetchable cross-org.

**SDK smoke test (9/9 passing)**: pagination shape, task CRUD round-trip,
`client.paginate()` cursor walking, 404/403 error typing, webhook create +
secret + test-send + delete, project validation error, marketplace browse,
and a full file upload/get/download/delete round-trip — all through the
actual published SDK code, against a live server.

**UI verification (Playwright + manual screenshot inspection)**: Developer
Console's Overview, API Keys (create → one-time secret reveal → list →
rotate → revoke), Webhooks (create → secret reveal → test-send → delivery
list), and Logs tabs all confirmed rendering and functioning against a real
backend. Admin Panel's new Public API usage section confirmed rendering real
aggregated data from generated live traffic.

**OpenAPI spec**: validated with `openapi-spec-validator` (37 paths, no
schema errors).

## 13. Production Readiness Assessment

**Honest assessment, not a blanket claim**: the Public API is real,
functional, and tested — every documented endpoint works end-to-end against
a live server, tenant isolation holds under a real 30-check regression
suite plus a live-reproduced-and-fixed vulnerability, SSRF protection is
real and tested, webhook signing/delivery mechanics are correct, and quota/
billing enforcement extends automatically to every API-key-originated
AI call via the same code path the web app uses.

It is **not** a finished, best-in-class public developer platform. Missing:
idempotency keys on writes, integration action execution, a feature-flag
admin UI, a Python SDK, real (non-sandboxed) webhook delivery validation,
and any third-party security review or load testing. None of these are
architectural blockers — the code is structured to add each one without
touching the rest (idempotency keys, in particular, are a self-contained
addition to `requestLog.js`/route handlers, not a redesign) — but until they
land, this is a solid, correctly-isolated v1 surface for internal or trusted
early-access developer use, not a hardened, fully-featured public platform
ready for unrestricted third-party traffic at scale.

*(§13's assessment above is exactly as it stood at Phase 17's completion.
§14 below is the follow-up hardening pass that closed most of the gaps
this assessment names — read on for the current picture.)*

---

# Phase 17.1 — Public API Hardening & Completion

A focused follow-up pass, explicitly scoped to closing four of the six
disclosed Phase 17 gaps (Idempotency-Key support, integration action
execution, a feature-flag admin UI, and a Python SDK) without redesigning
or rewriting anything already shipped. Every existing endpoint, table, and
service function from Phase 17 is untouched except where a task required
adding a new, additive middleware step (`idempotent()`, `requireCapability`
was already there) in front of it.

## 14. What Was Implemented

**1. Idempotency-Key support** (`server/publicApi/idempotency.js`,
`api_idempotency_keys` table) — an HTTP-layer request/response cache in
front of the existing route handlers, deliberately not a second job/queue
system. Applied to `POST /v1/agents/:id/execute`, `/messages`,
`POST /v1/automations/:id/run`, `POST /v1/content/{text,image,voice}`,
`POST /v1/tasks`, `POST /v1/projects`, and
`POST /v1/integrations/:provider/actions/:actionName/execute`. Scoped per
`(apiKeyId, idempotencyKey)` — never shared across keys or orgs, even for
the identical key string. A 5xx response is never cached (a failed-unknown
outcome shouldn't lock a client out of retrying). 24h TTL, swept every 15
minutes via the same `setInterval` pattern `sweepExpiredConfirmations`/
`sweepExpiredTrials` already use.

**2. Integration Action API** (`orchestrator/integrationApiService.js`'s
`PUBLIC_INTEGRATION_ACTIONS`, `GET/POST /v1/integrations/:provider/actions...`)
— a curated, explicitly-approved allowlist across 5 providers (gmail,
shopify, wordpress, woocommerce, whatsapp), never an arbitrary passthrough.
Execution reuses `orchestrator/executor.js`'s `runTool()` as-is — the exact
lifecycle an agent's own AI-driven tool call goes through, including the
agent-skill permission gate (`toolAvailableToAgent`), confirmation-gating
for actions that need it, and a real `tool_executions` audit row. New
scope: `integrations:execute`.

The one real architectural wrinkle this surfaced: every integration tool
in this codebase resolves credentials via `getConnection(userId, provider)`,
which follows the **calling user's `users.activeOrgId`** — a session-level
field — not `req.orgId`. Safe for a human in the web app; not automatically
safe for a machine API key, whose creator might have a different org
active. This endpoint explicitly verifies (never assumes) that what
`getConnection` would resolve for the API key's creator **is** the
organization's own connection before calling `runTool()` — otherwise it
rejects with `409 INTEGRATION_CONTEXT_MISMATCH`. This is a real,
by-design operational constraint (the API key creator must have the
target org active, with integrations permission, in the web app at call
time), documented in `API_SECURITY.md`'s new "Integration Actions"
section — not a workaround, and not hidden.

**3. Feature-flag admin UI** (`client/src/pages/AdminPanel.jsx`'s "Feature
flags" section, `GET /api/admin/feature-flags/audit-log`) — view, create,
enable/disable, emergency-disable, edit rollout %, add/remove per-org/user
overrides, delete, and a recent-changes audit trail. Zero new backend
gating logic — the Phase 16 flag engine and its existing
`/api/admin/feature-flags` routes are entirely unchanged; the audit-log
endpoint only narrows the pre-existing `activity_logs` table to
`feature_flag_*` actions (same pattern `listBillingLogs()` already used).

**4. Python SDK** (`sdk/python/`, package `autopilon`) — zero third-party
dependencies (stdlib `urllib` only, including a hand-rolled multipart
encoder for file upload, since `urllib` has none built in). Mirrors the JS
SDK's resource coverage exactly: agents, runs, automations, tasks,
projects, files, content, integrations (`list_actions`/`execute_action`),
marketplace, webhooks, plus `paginate()` and Idempotency-Key support.
`AutopilonApiError` carries the same `{code, message, request_id, status}`
shape as the JS SDK's error class.

**Also, not separately requested but done for consistency**: the JS SDK
gained `integrations.listActions`/`executeAction` and `idempotencyKey`
support on every write method that gained it server-side; `openapi.yaml`
gained the 2 new paths and an `IdempotencyKey` header parameter applied to
all 9 supporting operations (validated with `openapi-spec-validator`,
still 0 schema errors); 4 new feature-flag admin-authorization checks were
added to the core Phase 16 regression suite (a testing gap the original
suite had, not a gap in the shipped code).

## 15. What Was Actually Tested (and how)

Same discipline as every prior task this project: `node --check`/
`py_compile` for syntax, then real HTTP requests (or real SDK calls)
against a locally-booted server with real DB fixtures, explicit
cross-tenant checks, explicit artifact cleanup after every run — never
mocked, never claimed without running it.

- **Idempotency**: live-verified via curl before the automated suite
  existed — first request succeeds, identical retry replays
  (`Idempotency-Replayed: true`, same resource id), same key + different
  body → `409`, cross-org isolation (same key string on a different org's
  key never collides), and a **real concurrent-request test** (`Promise.all`
  firing two identical requests simultaneously) confirmed exactly one
  resource was ever created in the database, regardless of which HTTP
  response each concurrent caller received. `test/idempotencyRegression.js`:
  **10/10 passing**.
- **Integration Actions**: live-verified against a real (fixture-inserted,
  since no real OAuth provider is reachable in this sandbox) connected
  Gmail integration — the curated action list correctly excludes an
  internally-real-but-unapproved tool (`gmail.trash_email`); executing
  `gmail.list_emails` reached the **actual live Gmail API** and got a real
  Google-issued authentication error back (proof the full pipeline — auth,
  scope, org ownership, agent-skill gate, `runTool` dispatch — executed
  correctly end-to-end; the failure is only because the fixture token
  isn't a real one, see §16); cross-org isolation confirmed for both "no
  connection" and "connection exists but wrong agent id" cases,
  independently; the `activeOrgId`-mismatch safety check confirmed live
  (cleared a real user's `activeOrgId`, confirmed the request correctly
  rejects with `409` rather than silently proceeding). One flaky first
  test run using ambiguous Playwright/curl-adjacent selectors accidentally
  disabled the real `public_api_webhooks` flag — caught, restored, and the
  second test run used properly-scoped assertions.
  `test/integrationActionRegression.js`: **12/12 passing**.
- **Feature-flag admin UI**: live-verified via Playwright against a real
  booted server and a real platform-admin session — created a flag,
  disabled it (confirmed the action was scoped to that flag's own row by
  checking a sibling flag was unaffected), re-enabled it, added an org
  override (visible immediately), removed it, confirmed the audit log
  showed the create and override-set events, confirmed deletion via the
  backend API. Screenshots captured and visually inspected.
- **Python SDK**: `smoke_test.py` run against a live booted server with a
  real org and a real 14-scope API key — pagination shape, full task
  CRUD round-trip, cursor pagination via `client.paginate()`, a 404 error
  with the correct code, a full webhook create → secret → test-send →
  list → delete round-trip, a project-creation validation error, a
  byte-exact file upload → get → download → delete round-trip, an
  Idempotency-Key replay, and an integration-actions 404 for an
  unconnected provider. **10/10 passing.**
- **JS SDK updates**: a targeted 2-check spot test (idempotency replay,
  integration-actions 404) confirmed the new methods work through the
  actual published SDK code, not just by inspection.
- **Full-suite regression**, run together against **one continuously-running
  fresh server in a single session** (not five isolated claims run
  separately and never cross-checked): Phase 16 suite **24/24** (20
  original + 4 new feature-flag authorization checks), Phase 17 Public API
  suite **30/30**, Idempotency **10/10**, Integration Actions **12/12**,
  Python SDK smoke test **10/10** — **86/86 total**. A real, observed
  characteristic of this run: the existing 10-req/min-per-IP auth rate
  limiter (a pre-existing, intentional brute-force protection, not a bug)
  was hit once when chaining suites with zero pacing between them
  (roughly 10 signups across 4 suites landing right at the limiter's
  boundary); the fix was pacing, not touching the limiter, and is a note
  for future test-runner tooling, not a defect in the shipped code.

## 16. External Webhook Delivery Test — Exact Steps

Real end-to-end webhook delivery to an external receiver has **not** been
verified in this sandbox, and cannot be, honestly — this environment's own
outbound network proxy only allows a fixed domain allowlist, and a real
test requires delivering to a receiver of the developer's choosing (that's
the entire point of the feature). This was true at Phase 17's completion
and remains true here; nothing new in Phase 17.1 changes it. What *has*
been verified, repeatedly, across both phases: a real webhook created
against `https://example.com/...` and test-sent gets a real HTTP response
back (a proxy-issued `403` in this sandbox, correctly captured, signed,
and recorded as the delivery result) — proof the signing, HTTP-send,
response-capture, and error-classification logic all run correctly; only
the "does a receiver outside this sandbox actually get the bytes" step is
unverified here.

**To verify real external delivery once this app is deployed to a staging
or production environment with normal outbound internet access:**

1. Stand up a receiver you control that can log incoming requests — the
   fastest option is a temporary endpoint from a service like
   `webhook.site` or `requestbin.com` for a first pass, or a real endpoint
   in your own app for a production-representative test.
2. In the Developer Console (`/app/organizations/:id/developer` →
   Webhooks tab) or via the Public API (`POST /v1/webhooks`), create a
   webhook with that receiver's URL and at least one event type, e.g.
   `task.created`.
3. Copy the returned signing secret (`whsec_...`) — you'll need it for
   step 6.
4. Click **Test** in the Developer Console (or `POST
   /v1/webhooks/:id/test`) and confirm the receiver actually logs an
   incoming POST with a `200`-range response captured back in the
   Developer Console/API response — this proves basic reachability and
   that this deployment's outbound network isn't blocked.
5. Trigger a **real** event the webhook is subscribed to (e.g. create a
   task via `POST /v1/tasks` if subscribed to `task.created`) and confirm
   a delivery appears in `GET /v1/webhooks/:id/deliveries` with
   `status: "completed"` and a real `httpStatus`/`responseTimeMs`.
6. Verify signature checking on the receiving end: take the raw request
   body and the `X-Webhook-Signature` header from your receiver's logs,
   and confirm they validate against the copied secret using the
   verification snippet in `WEBHOOKS.md`'s "Verifying signatures" section.
   A mismatch here (rather than at step 4/5) would point to a body
   re-serialization issue on the *receiver's* side, not this platform's
   signing.
7. To verify the retry/dead-letter path specifically, point a webhook at
   a URL that returns a non-2xx (or is unreachable) and confirm
   `GET /v1/webhooks/:id/deliveries` shows increasing `attempts` with
   growing gaps between `lastAttemptAt` values (the documented
   `min(2^attempts*2, 300)` second backoff), settling at `status:
   "dead_letter"` after 3 attempts.
8. To verify SSRF protection is still correctly blocking in the real
   deployment's network (not just this sandbox's), attempt to create a
   webhook pointed at `http://169.254.169.254/latest/meta-data/` (or
   your cloud provider's actual metadata endpoint) and confirm it's
   rejected with `400 INVALID` at creation time — this is the single most
   important check to re-run in any new deployment target, since it's the
   one thing that must hold regardless of network environment.

None of this requires code changes — the implementation is complete and
was proven correct up to the network boundary this sandbox itself
imposes; steps 1–8 above are purely a deployment-environment verification
checklist, not a to-do list of missing functionality.

## 17. Remaining Known Limitations (Phase 17.1)

- Per-event webhook payload schema versioning — still not implemented
  (unchanged from Phase 17).
- Automatic re-drive of dead-lettered webhook deliveries — still not
  implemented (unchanged from Phase 17).
- Real external webhook delivery testing — architecture-complete,
  external-environment-dependent (§16 above).
- Third-party penetration testing / formal load testing of the Public
  API — not performed (unchanged from Phase 17).
- Integration Actions' curated allowlist covers 5 providers and a
  deliberately small action set per provider (§14) — expanding it is
  real, straightforward, per-action work (one line in
  `PUBLIC_INTEGRATION_ACTIONS`), not a redesign, but it is not
  exhaustive of every tool the Tool Registry already has.
- Integration Actions' `activeOrgId`-dependent credential resolution
  (§14) is a real operational characteristic of reusing the existing
  system as instructed, not a bug — but it does mean a Public API caller
  can hit `409 INTEGRATION_CONTEXT_MISMATCH` for a reason that isn't
  visible from the API alone (a human needs to switch their active org in
  the web app first). This is disclosed in `API_SECURITY.md`, not hidden,
  but it is a real UX rough edge worth a future pass if integration
  actions become a primary use case.
- No `Idempotency-Key` support on file upload or webhook creation
  (deliberately out of scope this pass — file upload's multipart body
  doesn't hash cleanly via the same JSON-based approach, and webhook
  creation's duplicate-risk is low).

## 18. Phase 17 / 17.1 — Final Classification

Every capability from both phases, classified honestly:

| Capability | Status |
|---|---|
| Agents API (list/get/execute/messages/runs) | **IMPLEMENTED + TESTED** |
| Automations API | **IMPLEMENTED + TESTED** |
| Tasks API | **IMPLEMENTED + TESTED** |
| Projects API | **IMPLEMENTED + TESTED** |
| Files API (upload/download/list/delete/signed URLs) | **IMPLEMENTED + TESTED** |
| Content Generation API | **IMPLEMENTED + TESTED** |
| Integrations API (read-only status) | **IMPLEMENTED + TESTED** |
| Marketplace browse API | **IMPLEMENTED + TESTED** |
| Developer webhooks: CRUD, signing, SSRF protection | **IMPLEMENTED + TESTED** |
| Developer webhooks: delivery mechanics (sign/send/capture/classify) | **IMPLEMENTED + TESTED** |
| Developer webhooks: real external delivery to a developer's receiver | **IMPLEMENTED + EXTERNAL TEST REQUIRED** (§16) |
| API request logging + Developer Console (backend + UI) | **IMPLEMENTED + TESTED** |
| Feature-flag gating of the Public API | **IMPLEMENTED + TESTED** |
| Admin analytics for Public API usage | **IMPLEMENTED + TESTED** |
| JS/TS SDK | **IMPLEMENTED + TESTED** |
| Public API security regression suite | **IMPLEMENTED + TESTED** |
| Idempotency-Key support | **IMPLEMENTED + TESTED** |
| Integration Action API (curated allowlist) | **IMPLEMENTED + TESTED**, with real credentials/network access **EXTERNAL TEST REQUIRED** for the underlying provider call itself (§15) |
| Feature-flag admin UI | **IMPLEMENTED + TESTED** |
| Python SDK | **IMPLEMENTED + TESTED** |
| Per-event webhook payload schema versioning | **NOT IMPLEMENTED** |
| Automatic re-drive of dead-lettered webhook deliveries | **NOT IMPLEMENTED** |
| Distributed (Redis-backed) rate limiting/queue/cache | **ARCHITECTURE ONLY** (inherited from Phase 16, unchanged) |
| Third-party penetration testing | **NOT IMPLEMENTED** |
| Formal load/DoS testing of the Public API | **NOT IMPLEMENTED** |
| Idempotency-Key on file upload / webhook creation | **NOT IMPLEMENTED** (deliberate scoping, §17) |
| Integration Actions beyond the 5-provider curated allowlist | **NOT IMPLEMENTED** (expansion is straightforward future work) |
