# Autopilon Public API (v1)

Status: **beta**. Base URL: `https://<your-deployment>/api/v1` (local dev: `http://localhost:4000/api/v1`).

This document describes the endpoints that actually exist and are wired up today. If something you'd expect isn't listed here, it isn't implemented yet — see [API_CHANGELOG.md](API_CHANGELOG.md) for what's planned.

For a step-by-step first-integration walkthrough, see [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md). For webhooks specifically, see [WEBHOOKS.md](WEBHOOKS.md). For the auth/tenancy/threat model, see [API_SECURITY.md](API_SECURITY.md). A machine-readable spec covering the same surface lives at [`openapi.yaml`](openapi.yaml).

## Authentication

Every request (except `GET /v1`) must carry an API key issued from your organization's Developer Console (`/app/organizations/:id/developer`, owner/admin only):

```
Authorization: Bearer ap_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are shown **once**, at creation or rotation — the server only ever stores a SHA-256 hash, never the raw secret. There is no session-cookie auth on `/v1`; a browser login token is not accepted here.

A key belongs to exactly one organization (`req.orgId`) and one creating user. Every endpoint below is scoped to that organization only — a key can never see or act on another org's data, and errors indistinguishably 404 rather than 403 where that matters (see API_SECURITY.md).

## Scopes

A key is created with an explicit, fixed set of scopes — there is no "all access" wildcard:

| Scope | Grants |
|---|---|
| `agents:read` | List/get agents, read runs |
| `agents:execute` | Execute an agent (`/execute`, `/messages`) |
| `agents:write` | *(reserved — no write endpoint uses this yet)* |
| `automations:read` | List/get automations and their runs |
| `automations:execute` | Trigger an automation run |
| `projects:read` | List/get projects and project items |
| `projects:write` | Create/update/archive projects, add/remove items |
| `tasks:read` | List/get tasks |
| `tasks:write` | Create/update/complete/archive tasks |
| `files:read` | List/get files, download content, create download links |
| `files:write` | Upload, delete files |
| `content:generate` | Generate text/image/voice content, read generated assets |
| `integrations:read` | List connected integrations |
| `usage:read` | *(reserved for future usage-query endpoints — Developer Console UI covers this today)* |
| `billing:read` | *(reserved — no endpoint uses this yet)* |
| `webhooks:manage` | Full CRUD on developer webhooks, view deliveries |
| `marketplace:read` | Browse marketplace assets and categories |

A request missing the scope its route requires gets `403 INSUFFICIENT_SCOPE`, never a silent partial response.

## Feature flags

Every resource area below sits behind its own feature flag (`public_api_agents`, `public_api_automations`, etc.), plus one master switch (`public_api`) covering the whole API. All flags default **on**. A platform admin can disable one resource area — or the whole API — globally or for a single organization, without a redeploy. A disabled capability returns `503 FEATURE_DISABLED`. See [API_SECURITY.md](API_SECURITY.md#feature-flag-gating) for details.

## Rate limits

Every response carries:

```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
X-RateLimit-Reset: 1755434400
```

The per-minute ceiling is plan-derived (free: 60, starter: 120, professional: 300, business: 600, enterprise: 1200 requests/minute), keyed by API key. Exceeding it returns `429 RATE_LIMITED` with a `Retry-After` header (seconds).

Agent execution and content generation additionally cap at **3 concurrent in-flight requests per key** — a 4th concurrent call is rejected rather than queued.

## Pagination

List endpoints (agents, runs, automations, automation runs, tasks, projects, files) use cursor pagination:

```
GET /v1/agents?limit=20&cursor=eyJjcmVhdGVkQXQiOi4uLn0
```

Response shape:

```json
{ "data": [...], "pagination": { "nextCursor": "eyJ...", "hasMore": true, "limit": 20 } }
```

`limit` defaults to 20, capped at 100. `cursor` is an opaque base64url token — pass back exactly what `nextCursor` returned; don't construct one yourself. A malformed/stale cursor is treated as "no cursor" (first page), not a 400.

The Marketplace browse endpoint (`/v1/marketplace/assets`) is **not** cursor-paginated — it's sorted by popularity/rating/recency, not a stable insertion order, so it uses a plain capped `limit` (max 100) instead.

## Errors

Every error follows the same shape:

```json
{ "error": { "code": "RESOURCE_NOT_FOUND", "message": "The requested agent was not found.", "request_id": "req_..." } }
```

`request_id` matches the `X-Request-ID` response header and the record in your organization's request logs (Developer Console → Logs tab) — include it when asking for support.

| Code | HTTP status | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing/malformed/invalid/revoked/expired API key |
| `INSUFFICIENT_SCOPE` | 403 | Key lacks the scope this route requires |
| `FEATURE_DISABLED` | 503 | The resource area (or the whole API) is currently flagged off for this org |
| `RESOURCE_NOT_FOUND` | 404 | No such resource in this org (also returned for another org's resource, to avoid confirming it exists) |
| `INVALID_REQUEST` / `INVALID` | 400 | Missing/malformed request body or query param |
| `QUOTA_EXCEEDED` | 429 | Organization's usage quota is exhausted |
| `RATE_LIMITED` | 429 | Per-key rate limit exceeded |
| `PROVIDER_NOT_CONFIGURED` | 503 | The org hasn't configured an AI/content provider needed for this call |
| `FILE_TOO_LARGE` | 413 | Upload exceeds the 500 MB limit |
| `INTERNAL_ERROR` | 500 | Unexpected server error (message is intentionally generic — no internal detail is ever included) |

## Idempotency

Send an `Idempotency-Key` header on a write request and a retried call with the exact same key **and** the exact same request body returns the original response again — the operation is not repeated:

```
POST /v1/tasks
Idempotency-Key: 3f7a9e21-...   (any string you generate, up to 255 chars — a UUID is a good default)
```

Supported on: `POST /v1/agents/:id/execute`, `POST /v1/agents/:id/messages`, `POST /v1/automations/:id/run`, `POST /v1/content/text`, `POST /v1/content/image`, `POST /v1/content/voice`, `POST /v1/tasks`, `POST /v1/projects`. Not supported on other endpoints (list/get/update/delete calls don't need it; file upload and webhook creation are deliberately out of scope for now — see API_SECURITY.md).

Behavior:
- **No header** — the endpoint behaves exactly as if idempotency didn't exist; nothing is deduplicated. This is opt-in.
- **First use of a key** — the request runs normally; the exact HTTP response is stored against that key.
- **Same key + identical body, within 24h** — the original stored response is replayed verbatim, with `Idempotency-Replayed: true` added. The operation does **not** run again.
- **Same key + a different body** — rejected with `409 IDEMPOTENCY_KEY_CONFLICT`. Reusing a key for a different request is treated as a client bug, not silently allowed.
- **Two requests with the same key arriving concurrently** — only one is allowed to execute; the other gets `409 IDEMPOTENCY_KEY_IN_PROGRESS` (retry shortly) rather than being allowed to run in parallel and risk a duplicate.
- **A request that fails with a 5xx** is *not* cached — the server doesn't know whether the underlying operation actually happened, so the same key can be retried once the transient issue clears, instead of being locked out for 24h.
- Keys are scoped to the specific API key that made the request — two different keys (even in the same organization) using the identical `Idempotency-Key` string never collide or interfere with each other.
- Reservations expire and are swept 24 hours after creation; an expired key is treated as brand new.

Async agent execution (`"async": true`) and webhook delivery separately also run through the Job Manager, which has its own retry-with-backoff for the underlying job — the `Idempotency-Key` header above governs the HTTP request itself (so a retried `POST .../execute?async=true` doesn't enqueue a second job in the first place).

---

## Agents

### `GET /v1/agents`
List agents in your organization. Scope: `agents:read`.

Response item:
```json
{
  "id": "...", "name": "...", "description": "...", "personality": "...",
  "status": "active", "category": "...", "scope": "org",
  "createdAt": "...", "updatedAt": "..."
}
```
The agent's system prompt/instructions are **never** exposed.

### `GET /v1/agents/:id`
Get one agent. Scope: `agents:read`. `404 RESOURCE_NOT_FOUND` if it doesn't exist in your org.

### `GET /v1/agents/:id/runs`
List past runs for an agent (cursor-paginated). Scope: `agents:read`.

### `POST /v1/agents/:id/execute`
Run the agent. Scope: `agents:execute`.

Request:
```json
{ "message": "Summarize this week's sales.", "conversationId": "optional-existing-conversation", "async": false }
```
- `async: false` (default) — blocks until the agent replies, returns the full run.
- `async: true` — returns `202` immediately with a `status: "queued"` run; poll `GET /v1/runs/:id`.

Synchronous response (`200`):
```json
{
  "id": "run_...", "agentId": "...", "conversationId": "...", "jobId": null,
  "mode": "sync", "status": "completed", "response": "The reply text...",
  "usage": { "promptTokens": 412, "completionTokens": 88 },
  "error": null, "createdAt": "...", "completedAt": "...", "reply": "The reply text..."
}
```
Async response (`202`): same shape with `status: "queued"`, `response: null`, `completedAt: null`.

Subject to the org's configured AI spend limit — a `429 QUOTA_EXCEEDED` means the organization has hit its own configured cap, same enforcement as the internal chat UI.

### `POST /v1/agents/:id/messages`
A lighter, always-synchronous alias for simple "send a message, get a reply" integrations. Scope: `agents:execute`.

Request: `{ "message": "...", "conversationId": "optional" }`
Response: `{ "conversationId": "...", "response": "...", "usage": { "promptTokens": 412, "completionTokens": 88 } }`

## Runs

### `GET /v1/runs/:id`
Get a single agent run by id (works even if you only have the run id, not its agent id). Scope: `agents:read`.

## Automations

### `GET /v1/automations`
List automations (cursor-paginated). Scope: `automations:read`.

### `GET /v1/automations/:id`
Get one automation. Scope: `automations:read`.

### `POST /v1/automations/:id/run`
Trigger a manual run. Scope: `automations:execute`. Body: `{ "variables": { ... } }` (optional). `400 INVALID` if the automation isn't `active`.

### `GET /v1/automations/:id/runs`
List runs for an automation (cursor-paginated). Scope: `automations:read`.

### `GET /v1/automations/runs/:runId`
Get a single automation run by id. Scope: `automations:read`.

## Tasks

Org-scoped task list (a separate, additive layer over the same `tasks` table the internal personal to-do feature uses — see PUBLIC_API internals note in code).

### `GET /v1/tasks` — list (cursor-paginated). Scope: `tasks:read`.
### `GET /v1/tasks/:id` — get one. Scope: `tasks:read`.
### `POST /v1/tasks` — create. Scope: `tasks:write`.
```json
{ "title": "Follow up with client", "description": "...", "priority": "medium", "dueDate": "2026-09-01" }
```
### `PATCH /v1/tasks/:id` — update any of `title`, `description`, `status` (`todo`/`in_progress`/`completed`/`archived`), `priority`, `dueDate`. Scope: `tasks:write`.
### `POST /v1/tasks/:id/complete` — shortcut for `PATCH { status: "completed" }`. Scope: `tasks:write`.
### `DELETE /v1/tasks/:id` — archives (soft-delete), shortcut for `PATCH { status: "archived" }`. Scope: `tasks:write`.

## Projects

### `GET /v1/projects` — list (cursor-paginated). Scope: `projects:read`.
### `GET /v1/projects/:id` — get one. Scope: `projects:read`.
### `POST /v1/projects` — create. Scope: `projects:write`. Body: `{ "workspaceId": "...", "name": "...", "description": "..." }` — `workspaceId` is required and must belong to your org.
### `PATCH /v1/projects/:id` — update. Scope: `projects:write`.
### `DELETE /v1/projects/:id` — archive. Scope: `projects:write`.
### `GET /v1/projects/:id/items` — list items attached to a project. Scope: `projects:read`.
### `POST /v1/projects/:id/items` — attach an item. Scope: `projects:write`. Body: `{ "itemType": "...", "itemId": "..." }`.
### `DELETE /v1/projects/:id/items/:itemType/:itemId` — detach an item. Scope: `projects:write`.

Writes here delegate to the same project-management logic the web UI uses, including its own owner/admin role check — an API key can never do more than its creating user could do in the web app.

## Files

### `GET /v1/files?folderId=...` — list (cursor-paginated). Scope: `files:read`.
### `GET /v1/files/:id` — metadata. Scope: `files:read`.
### `POST /v1/files/upload` — multipart upload (`multipart/form-data`, field name `file`, plus optional `folderId`, `visibility`, `tags` as a comma-separated string). Scope: `files:write`. Max 500 MB.
### `GET /v1/files/:id/content` — stream the raw file bytes, authenticated by the same API key. Scope: `files:read`.
### `POST /v1/files/:id/download-url` — mint a signed, time-limited download link (default 1 hour, min 60s, max 7 days) usable without the API key — for handing to a browser or another service. Scope: `files:read`. Body: `{ "expiresInSeconds": 3600 }` (optional).
### `DELETE /v1/files/:id` — trash the file. Scope: `files:write`.

## Content Generation

### `GET /v1/content/:id` — read back a generated asset. Scope: `content:generate`.
```json
{ "id": "...", "contentType": "...", "title": "...", "textContent": "...", "fileId": "...", "status": "...", "createdAt": "..." }
```
Media assets (image/voice) store a `fileId` reference into the File System, not a direct URL — fetch bytes via `GET /v1/files/:fileId/content` or mint a link via `POST /v1/files/:fileId/download-url`.

### `POST /v1/content/text` — Scope: `content:generate`. Body: `{ "contentType": "...", "brief": "...", "tone": "...", "targetAudience": "...", "keywords": [...], "title": "...", "agentId": "optional" }`. `contentType` and `brief` are required.
### `POST /v1/content/image` — Scope: `content:generate`. Body: `{ "prompt": "...", "negativePrompt": "...", "size": "...", "quality": "...", "numImages": 1, "title": "...", "agentId": "optional" }`. Returns an array of assets (one per generated image). `prompt` is required.
### `POST /v1/content/voice` — Scope: `content:generate`. Body: `{ "text": "...", "voice": "...", "speed": 1.0, "title": "...", "agentId": "optional" }`. `text` is required.

All three enforce the org's existing quota/spend-limit/usage-billing logic automatically (the same code path the internal Content Studio uses) — no separate cost control here.

## Integrations

### `GET /v1/integrations`
List connected integrations for the org. Scope: `integrations:read`.
```json
{ "data": [ { "provider": "shopify", "status": "connected", "createdAt": "..." } ] }
```
Read-only. Never returns an OAuth token, refresh token, or any other credential.

**Known limitation**: there is no endpoint to *execute* an integration action (send an email, create a product, post to WhatsApp, etc.) through the Public API directly. The real path today is `POST /v1/agents/:id/execute` against an agent that has the relevant skill/tool enabled — every integration action already exists as a Tool an agent can call. A curated per-provider action API is not implemented.

## Marketplace

### `GET /v1/marketplace/assets?q=&assetType=&categoryId=&sort=&limit=`
Browse published, moderation-approved, non-private marketplace assets. Scope: `marketplace:read`. Not cursor-paginated (see Pagination above); `limit` capped at 100.

### `GET /v1/marketplace/categories`
List marketplace categories. Scope: `marketplace:read`.

## Webhooks (management)

Full CRUD for your organization's outgoing webhook subscriptions. See [WEBHOOKS.md](WEBHOOKS.md) for event types, payload shape, and signature verification. All routes require scope `webhooks:manage`.

- `GET /v1/webhooks/event-types` — the full list of subscribable event types.
- `GET /v1/webhooks` — list your org's webhooks.
- `GET /v1/webhooks/:id` — get one.
- `POST /v1/webhooks` — create. Body: `{ "url": "https://...", "description": "...", "events": ["agent.run.completed", ...] }`. The URL is validated against SSRF rules at creation time (see API_SECURITY.md).
- `GET /v1/webhooks/:id/secret` — reveal the signing secret (re-viewable, not one-time — your receiver needs the same secret this server has).
- `PATCH /v1/webhooks/:id` — update `url`, `description`, `events`, or `status` (`active`/`disabled`).
- `DELETE /v1/webhooks/:id` — delete.
- `POST /v1/webhooks/:id/test` — send a synchronous `test.ping` event and return the real delivery result (HTTP status, latency, error if any).
- `GET /v1/webhooks/:id/deliveries?limit=50` — delivery history (max 200).
