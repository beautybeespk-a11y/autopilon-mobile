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
