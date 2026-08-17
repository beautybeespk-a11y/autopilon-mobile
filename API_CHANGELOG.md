# Autopilon Public API Changelog

The Public API is versioned by URL prefix (`/api/v1`). This changelog tracks what shipped, not a roadmap wishlist — see "Not yet implemented" at the bottom for known gaps.

## v1.1 — 2026-08-17 (hardening & completion pass, status: beta)

Phase 17.1 — closes four of the six gaps disclosed at v1's launch, without redesigning any existing endpoint.

**Idempotency-Key**
- Opt-in `Idempotency-Key` header on `POST /v1/agents/:id/execute`, `/messages`, `POST /v1/automations/:id/run`, `POST /v1/content/{text,image,voice}`, `POST /v1/tasks`, `POST /v1/projects`, and `POST /v1/integrations/:provider/actions/:actionName/execute`.
- A retried request with the same key and identical body replays the original response (`Idempotency-Replayed: true`); a different body with the same key is a `409 IDEMPOTENCY_KEY_CONFLICT`; a genuinely concurrent duplicate is `409 IDEMPOTENCY_KEY_IN_PROGRESS`. Scoped per API key — never shared across keys or orgs. 24h TTL, swept every 15 minutes.

**Integration Actions**
- `GET /v1/integrations/:provider/actions` and `POST /v1/integrations/:provider/actions/:actionName/execute` — a curated, explicitly-approved subset of the internal Tool Registry (gmail, shopify, wordpress, woocommerce, whatsapp), gated by the calling agent's own enabled skills, with confirmation-gating preserved for actions that need it.
- New scope: `integrations:execute`.

**Feature-flag admin UI**
- The Admin Panel now has a full "Feature flags" section: view, create, enable/disable, emergency-disable, edit rollout %, org/user overrides, delete, and a recent-changes audit log. No new backend gating — the Phase 16 flag engine and its existing `/api/admin/feature-flags` routes are unchanged.

**Python SDK**
- `sdk/python/` (`autopilon-sdk`) — a zero-dependency stdlib-only client mirroring the JS SDK's coverage: agents, runs, automations, tasks, projects, files, content, integrations, marketplace, webhooks, plus `paginate()` and Idempotency-Key support.

**Also**
- `sdk/js/` extended with `integrations.listActions`/`executeAction` and `idempotencyKey` support on every write method that gained it.
- `openapi.yaml` bumped to 1.1: 2 new paths, `Idempotency-Key` header parameter applied to all 9 supporting operations.
- New scope `integrations:execute` (18 scopes total).
- 4 new feature-flag admin-authorization checks added to the core security regression suite.
- New test suites: `test/idempotencyRegression.js` (10 checks), `test/integrationActionRegression.js` (12 checks), `sdk/python/smoke_test.py` (10 checks).

**Remaining gaps** (unchanged from v1, still disclosed, not hidden):
- Per-event webhook payload schema versioning.
- Automatic re-drive of dead-lettered webhook deliveries.
- Real (non-sandboxed) external webhook delivery testing — requires a staging/production environment with real outbound network access; see PHASE17_NOTES.md's Phase 17.1 section for the exact steps to run once deployed.
- Third-party penetration testing / formal load testing of the Public API specifically.

## v1 — 2026-08-17 (initial release, status: beta)

First release of the Public API & Developer Platform (Phase 17).

**Authentication & authorization**
- Bearer API key authentication, org-scoped, hashed at rest (never encrypted/reversible).
- 17-scope least-privilege model; a key can only be created with an explicit scope list.
- Key lifecycle: create, list, revoke, rotate — via the session-authenticated Developer Console (owner/admin only).

**Resources**
- Agents: list, get, execute (sync + async), lightweight `/messages` alias, list runs.
- Runs: get by id.
- Automations: list, get, trigger, list runs, get run by id.
- Tasks: list, get, create, update, complete, archive.
- Projects: list, get, create, update, archive, list/add/remove items.
- Files: list, get, upload (multipart, 500 MB max), stream content, mint time-limited signed download links, delete.
- Content Generation: text, image, voice generation; read back a generated asset.
- Integrations: read-only list of connected integrations and their status.
- Marketplace: browse published assets, list categories.

**Developer webhooks**
- Full CRUD, SSRF-protected URLs (validated at creation and immediately before every delivery).
- 13 event types across agent runs, automation runs, tasks, files, content, integrations, and usage thresholds.
- Stripe-convention HMAC-SHA256 signing (`t=...,v1=...`), replay-resistant.
- Delivery via the platform's existing Job Manager: retry with exponential backoff, dead-lettering after 3 attempts.
- Synchronous test-send endpoint and real delivery history.

**Platform**
- Cursor-based pagination shared across all list endpoints (except Marketplace browse, which is sort-based).
- Consistent `{ error: { code, message, request_id } }` error shape across every endpoint.
- Per-key, plan-derived rate limiting with standard `X-RateLimit-*` headers; separate concurrency cap on AI-heavy routes.
- Per-request `X-Request-ID`, logged and queryable via the Developer Console.
- Feature-flag gating: one master switch plus one flag per resource area, with global and per-org override support.
- Developer Console web UI (API Keys / Webhooks / Usage Overview / Request Logs tabs) under each organization.
- Minimal JS/TS SDK (`sdk/js/`) covering the endpoints above.

**Not yet implemented** (see [API_SECURITY.md](API_SECURITY.md#known-limitations-disclosed-not-hidden) and [PUBLIC_API.md](PUBLIC_API.md) for details on each):
- `Idempotency-Key` support on synchronous write endpoints.
- Integration *action* execution through the Public API (read-only status only today).
- Admin web UI for feature-flag management (API-only).
- Per-event webhook payload schema versioning.
- Automatic re-drive of dead-lettered webhook deliveries.
- Third-party penetration testing / formal load testing of the Public API specifically.

---

Future releases will be appended above this line, oldest at the bottom of each release's own section. Breaking changes will ship as a new version prefix (`/api/v2`) rather than mutating `/api/v1`'s existing contract — see `server/publicApi/router.js` for the v2-preparation note in the resource-sub-router structure.
