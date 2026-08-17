# Autopilon Developer Guide

A first-integration walkthrough for the Autopilon Public API. For the full endpoint reference see [PUBLIC_API.md](PUBLIC_API.md); for webhooks see [WEBHOOKS.md](WEBHOOKS.md).

## 1. Create an API key

You need to be an **owner or admin** of the organization you're integrating.

1. Log into the web app and open your organization.
2. Click **Developer** next to the Dashboard button.
3. Go to the **API Keys** tab, give the key a name, pick the scopes it needs (least privilege — only check what you'll actually use), and click **Create key**.
4. Copy the key immediately. It's shown once — the server only stores a hash of it, so if you lose it your only option is to rotate (issue a new secret) or revoke and create a new key.

There's no self-serve API for creating your *first* key — it's a chicken-and-egg problem (you'd need a key to call the API that creates a key), so key management always goes through the session-authenticated Developer Console, never `/v1` itself.

## 2. Make your first request

```bash
curl https://<your-deployment>/api/v1/agents \
  -H "Authorization: Bearer ap_live_..."
```

```json
{ "data": [], "pagination": { "nextCursor": null, "hasMore": false, "limit": 20 } }
```

An empty `data` array just means the org has no agents yet — create one in the web app first if you want something to execute.

## 3. Run an agent

```bash
curl -X POST https://<your-deployment>/api/v1/agents/<agentId>/execute \
  -H "Authorization: Bearer ap_live_..." \
  -H "Content-Type: application/json" \
  -d '{"message": "What were our top 3 products last week?"}'
```

This blocks until the agent replies (same latency as using the chat UI). For a long-running task, pass `"async": true` — you'll get back a `202` with a `status: "queued"` run immediately; poll `GET /v1/runs/:id` until `status` is `completed` or `failed`.

## 4. Paginate a list

```bash
curl "https://<your-deployment>/api/v1/tasks?limit=50" -H "Authorization: Bearer ap_live_..."
# -> { "data": [...50 tasks...], "pagination": { "nextCursor": "eyJ...", "hasMore": true, "limit": 50 } }

curl "https://<your-deployment>/api/v1/tasks?limit=50&cursor=eyJ..." -H "Authorization: Bearer ap_live_..."
# -> the next page
```

Stop when `pagination.hasMore` is `false`.

## 5. Handle errors and rate limits

Every error is `{ "error": { "code", "message", "request_id" } }`. Check `error.code`, not the message text (messages may change wording; codes won't). On `429 RATE_LIMITED`, back off for the number of seconds in the `Retry-After` header before retrying.

If something looks wrong, grab the `request_id` from the error body (or the `X-Request-ID` response header) — it maps 1:1 to a row your organization can see in the Developer Console's Logs tab.

## 6. Subscribe to webhooks (optional)

Instead of polling `GET /v1/runs/:id`, register a webhook so Autopilon calls *you* when something finishes:

```bash
curl -X POST https://<your-deployment>/api/v1/webhooks \
  -H "Authorization: Bearer ap_live_..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://yourapp.com/webhooks/autopilon", "events": ["agent.run.completed", "agent.run.failed"]}'
```

The response includes a `secret` — save it, it's how you'll verify incoming deliveries are really from Autopilon. Full details, payload shape, and a verification code sample: [WEBHOOKS.md](WEBHOOKS.md).

## 7. Use the SDK (optional)

A minimal JS/TS client wrapping the endpoints above is available — see [`sdk/js/README.md`](sdk/js/README.md). It covers authentication, pagination, and typed error handling; it does not wrap anything not documented in PUBLIC_API.md. There is currently no Python SDK.

## Common pitfalls

- **Using a session cookie instead of a Bearer key.** `/api/v1` never accepts a browser session — you'll get `401 UNAUTHENTICATED` even while logged into the web app in the same browser.
- **Forgetting a scope.** `403 INSUFFICIENT_SCOPE` names the exact scope you're missing — go back to the Developer Console and issue a new key (scopes can't be edited on an existing key; rotate or create a new one).
- **Forgetting the `Idempotency-Key` header on retries.** Without it, a retried `POST` after a timeout creates a duplicate resource — the endpoint has no way to know it's a retry. Generate a key (a UUID is fine) once per logical operation and send the same one on every retry attempt of that operation; see [PUBLIC_API.md](PUBLIC_API.md#idempotency) for exactly which endpoints support it.
- **Treating a `404` as "definitely doesn't exist anywhere."** A resource belonging to a *different* organization also 404s, on purpose — the API never confirms another org's data exists.
