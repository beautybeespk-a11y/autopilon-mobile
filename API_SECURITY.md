# Autopilon Public API — Security Model

This document describes how the Public API (`/api/v1`) is authenticated, isolated, and protected, for anyone evaluating whether it's safe to integrate against or reviewing it as a security control. It documents what's actually implemented and tested, not an aspirational target.

## Authentication

- Bearer API keys only (`Authorization: Bearer ap_live_...`). Session cookies are never accepted on `/v1` — the two auth mechanisms are deliberately kept separate (`server/publicApi/auth.js` vs. `server/middleware.js`'s `requireAuth`).
- Keys are generated as `ap_live_<32 random bytes, base64url>` (`crypto.randomBytes(32)` — cryptographically secure).
- **Keys are hashed, not encrypted.** The server stores only `SHA-256(rawKey)`; the raw secret exists only at creation/rotation time, in the API response, never again. This is a deliberate difference from BYOK provider keys (which the platform must decrypt to actually call the provider, so those use reversible AES-256-GCM encryption instead) — a developer API key never needs to be read back by the server, only compared.
- A revoked, expired, or simply-wrong key all produce the same generic `401 UNAUTHENTICATED` — the API never distinguishes "wrong key" from "expired key" from "revoked key" to whoever presents the invalid credential (that distinction is visible to the org itself, via the Developer Console).
- Every successful authentication updates `lastUsedAt`, visible to the org in the Developer Console.

## Authorization (scopes)

- A key is created with an explicit, fixed set of scopes drawn from a closed list (`API_SCOPES` in `server/orchestrator/apiKeyService.js`) — there is no wildcard/"all access" scope, and scopes cannot be inferred or escalated (`agents:write` does not imply `agents:read`; each route checks its own required scope independently).
- Only an organization **owner or admin** can create, rotate, or revoke keys for that org (enforced by the session-authenticated Developer Console backend, `server/routes/developerConsole.js`) — a plain member cannot mint API access for the org.
- Scope checks happen as their own middleware step (`requireScope(scope)`), applied per-route, so the required scope is visible at the point of declaration in each router file rather than buried in shared logic.

## Tenant isolation

This is the property most worth scrutinizing in a multi-tenant API, and the one this phase spent the most effort on. Every rule below is enforced, not just documented:

- Every service function backing a Public API route filters directly by `req.orgId` (the organization the authenticating key belongs to) in its own SQL query. None of them delegate to an internal "can this user access this resource" check, because those internal checks are scoped to **the calling user's entire personal org membership** (every org they belong to), not the one org this specific key was issued for. A key issued for Org A must never be able to read or act on Org B's data just because the key's *creator* also happens to be a member of Org B — this exact gap class was found and fixed in the internal chat route during this phase (`routes/chat.js`, commit `4dd1389`) and was designed against preemptively in every new Public-API-only service (`agentApiService.js`, `automationApiService.js`, `projectApiService.js`, `fileApiService.js`, `contentApiService.js`, `taskApiService.js`, `integrationApiService.js`).
- A resource belonging to a different org (or not existing at all) both return the same `404 RESOURCE_NOT_FOUND` — never a `403` that would confirm the resource exists somewhere else.
- Where a Public API write delegates to an existing internal service function that has its own role check (e.g. project create/update requiring workspace owner/admin via `projectManager.js`), that check is intentionally **kept**, not bypassed — an API key must never be able to do more than its creating user could already do through the web UI. Tenant-scoping and permission-scoping are separate, both-required gates.
- Verified by the project's standing 20-check security regression suite (`server/test/securityRegression.js`), run after every task in this phase — IDOR, cross-tenant, and privilege-escalation checks, 20/20 passing as of this document.

## SSRF protection (webhooks)

The one place the Public API causes this server to make an outbound request to an address a developer chose is a webhook URL — see [WEBHOOKS.md](WEBHOOKS.md#url-requirements-ssrf-protection) for the full rule set (blocks loopback, RFC1918 private ranges, link-local/cloud-metadata, CGNAT, and their IPv6 equivalents; re-validated immediately before every delivery, not just at creation, to close the DNS-rebinding gap a creation-time-only check would leave open).

## Rate limiting & abuse controls

- Per-key, plan-derived requests/minute ceiling (`server/publicApi/rateLimit.js`), reusing the same rate-limiting engine (`orchestrator/rateLimiter.js`) every other part of the platform uses — not a second implementation.
- AI-heavy routes (agent execution, content generation) additionally cap at 3 concurrent in-flight requests per key, independent of the per-minute ceiling.
- Every response carries `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`; a throttled request gets `429 RATE_LIMITED` with `Retry-After`.
- Organization-level AI spend limits (Phase 16 cost controls) apply automatically to every Public API call that triggers AI usage — there is no separate, weaker limit for API-key-originated traffic than for the web app.

## Feature-flag gating

Every Public API resource area sits behind its own feature flag, plus one master switch for the whole API (`server/publicApi/featureGate.js`), built on the same feature-flag engine (`orchestrator/featureFlags.js`) every other kill switch in the platform uses — not a parallel system. This means:

- A platform admin can disable the entire Public API, or one resource area, instantly, without a redeploy, in response to an incident.
- The same engine supports per-organization overrides, so a capability can be kept off by default while enabled for a specific early-access org, or the reverse (killed for one misbehaving org while everyone else keeps working).
- All flags default enabled — this phase changes what's *possible* to control, not what's on by default.
- **Known gap**: there is no dedicated admin web UI for managing these flags yet (a pre-existing Phase 16 gap, not introduced by this feature) — flags are toggled via the already-existing `/api/admin/feature-flags` REST endpoints (platform-admin-only, session-authenticated).

## Audit logging & observability

- Every Public API request is logged (`api_request_logs` table) with method, path, status, latency, and the authenticating key — visible to the organization via the Developer Console's Logs tab and `GET .../developer/logs`.
- Every response carries `X-Request-ID`, echoed in error bodies as `request_id`, so a specific call can be traced end-to-end.
- Sensitive administrative actions on API keys and webhooks (create, rotate, revoke, delete) are recorded in the organization's activity log via the same `logActivity()` mechanism the rest of the platform uses.

## Integration Actions

`POST /v1/integrations/:provider/actions/:actionName/execute` (Phase 17.1 §2) reuses the existing Tool Registry and agent-skill permission system — it is **not** an arbitrary passthrough to a provider's API. Every layer of protection applies:

- **Curated allowlist**: only the exact tool names listed in `PUBLIC_INTEGRATION_ACTIONS` (`orchestrator/integrationApiService.js`) are reachable — an action registered internally but not on this list returns `404`, indistinguishable from a nonexistent action. Current list: `gmail` (list/search/read emails, send email), `shopify` (list/get products and orders), `wordpress` (list posts, create post), `woocommerce` (list products, list orders), `whatsapp` (list/get conversations, send message). Expanding this list is a deliberate, one-line code change per action, never automatic.
- **Organization ownership**: the org must have its own `connected` integration row for the provider (`getOrgConnection`), verified before anything else runs.
- **Agent-based tool permissions**: every call requires an `agentId` belonging to the calling org, and the action runs through the exact same `toolAvailableToAgent()` gate an agent's own AI-driven tool call goes through — an agent without the matching skill enabled is denied, with the same error message a human would see in the chat UI.
- **A real architectural constraint, verified explicitly, not assumed**: every integration tool in this codebase (not just the ones exposed here) resolves its credentials via `getConnection(userId, provider)`, which follows the **calling user's `activeOrgId`** — a session-level field, not `req.orgId`. This is safe for the web app (a human switches org, their tools follow) but is not automatically safe for a machine API key. Before calling the underlying tool, this endpoint explicitly verifies that what `getConnection` would resolve for the API key's creator **is the same row** as the organization's own connection (`orgConn.id === resolvedForCaller.id`) — if the creator's active organization doesn't match, the request is rejected with `409 INTEGRATION_CONTEXT_MISMATCH` rather than silently executing against whichever organization the user happened to be "in" at that moment. This is the same "verify explicitly, never trust a broader-scoped resolution" discipline applied to every other cross-tenant risk in this phase (see §Tenant Isolation in PHASE17_NOTES.md).
- **Confirmation gating preserved**: an action that requires human approval internally (`gmail.send_email`) behaves identically through the Public API — it returns `awaiting_confirmation` and a notification is sent to the org; it does not bypass that safety net just because the caller is a machine.
- **Audit logging**: every call creates a real `tool_executions` row via the existing `runTool()` lifecycle (the same audit trail an agent's own tool call produces), in addition to the Public API's own `api_request_logs` row.
- **Quotas, usage tracking, billing, rate limits**: this endpoint sits behind the same `apiRateLimit()` and `requireCapability("public_api_integrations")` gate as every other Public API route. There is currently no separate per-tool-call billing/quota system anywhere in this platform (only AI generation is metered) — this endpoint does not bypass anything that exists, because there is nothing beyond rate limiting that currently exists to bypass.

## Secrets handling

- API key secrets: hashed (SHA-256), shown once, never recoverable — see Authentication above.
- Webhook signing secrets: encrypted at rest (AES-256-GCM, the same `secretsCrypto.js` module BYOK provider keys use) and **re-viewable** on demand (`GET /v1/webhooks/:id/secret`) — a receiver needs the same secret this server holds to verify signatures, so this one secret type is deliberately not one-time-only.
- No endpoint ever returns a BYOK provider credential, an OAuth access/refresh token, or a stack trace. Unexpected (uncategorized) server errors return a generic `500` message — internal detail never leaks into an error response, by construction of `apiErrorFromException()`.

## Known limitations (disclosed, not hidden)

- `Idempotency-Key` support (Phase 17.1) covers the main write endpoints (agent execute/messages, automation run, content generation, task/project create) — see PUBLIC_API.md. File upload and webhook creation are not covered.
- Integration *action* execution (Phase 17.1) covers a curated, small set of actions across 5 providers (see §Integration Actions above) — not every registered internal tool, and expanding the list is deliberate per-action work, not automatic.
- No admin UI for feature flags (API-only today).
- This phase's security testing covered functional/regression checks (the 20-check suite) plus targeted manual verification of the specific SSRF, tenant-isolation, and quota-bypass scenarios described above. It did not include third-party penetration testing or a formal load/DoS test against the Public API specifically. Treat this document as a description of implemented controls, not a certification.
