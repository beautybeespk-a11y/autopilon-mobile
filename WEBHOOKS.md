# Autopilon Developer Webhooks

Webhooks let your server get notified when something happens in your organization, instead of polling the Public API. This document covers event types, payload shape, signature verification, and delivery/retry behavior. For the CRUD endpoints themselves, see [PUBLIC_API.md](PUBLIC_API.md#webhooks-management).

## Registering a webhook

```bash
curl -X POST https://<your-deployment>/api/v1/webhooks \
  -H "Authorization: Bearer ap_live_..." -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.com/webhooks/autopilon",
    "description": "Production handler",
    "events": ["agent.run.completed", "agent.run.failed"]
  }'
```

Response includes a `secret` (`whsec_...`) — this is **re-viewable** (not one-time like an API key), because your receiving server needs the exact same secret this server holds to verify signatures. Retrieve it again any time via `GET /v1/webhooks/:id/secret`.

`events` can also be `["*"]` to subscribe to everything.

### URL requirements (SSRF protection)

Your webhook URL is checked, both when you create/update it **and again immediately before every delivery attempt** (DNS can change between the two — a stale creation-time check alone isn't real protection):

- Must be `http://` or `https://`.
- Cannot resolve to localhost, a loopback address, a private (RFC1918) range, link-local (including `169.254.169.254` — every major cloud's instance-metadata endpoint), CGNAT shared space, or their IPv6 equivalents.
- Cannot target `localhost`, `*.localhost`, or `metadata.google.internal` by hostname.
- Every IP a hostname resolves to is checked, not just the first — a round-robin/rebinding hostname can't slip one safe-looking address past the check and then serve from a private one.

A URL that fails this check is rejected at creation with `400 INVALID`; a URL that fails it at delivery time (e.g. DNS changed after creation) is recorded as a blocked delivery attempt, not silently retried forever.

## Event types

| Event | Fired when |
|---|---|
| `agent.run.started` | An agent execution begins (sync or async) |
| `agent.run.completed` | An agent execution finishes successfully |
| `agent.run.failed` | An agent execution errors |
| `automation.started` | An automation run begins |
| `automation.completed` | An automation run finishes successfully |
| `automation.failed` | An automation run errors |
| `task.created` | A task is created via the Public API |
| `task.completed` | A task's status is set to `completed` |
| `file.uploaded` | A file is uploaded (via the Public API *or* the web app — this event fires for both) |
| `content.generated` | A text/image/voice generation completes |
| `integration.connected` | An integration is connected |
| `integration.disconnected` | An integration is disconnected |
| `usage.threshold_reached` | The org crosses a configured AI-spend alert threshold |

Get this list at runtime from `GET /v1/webhooks/event-types`.

## Payload shape

Every delivery POSTs a JSON body:

```json
{
  "id": "evt_...",
  "type": "agent.run.completed",
  "createdAt": "2026-08-17T12:00:00.000Z",
  "data": { "runId": "...", "agentId": "...", "conversationId": "..." }
}
```

`data`'s shape depends on `type` — it's exactly the payload the emitting code passed at the point of the event, not a separately-documented schema per event today (a known gap — see below).

## Verifying signatures

Every delivery carries these headers:

```
X-Webhook-Signature: t=1755434400,v1=6a1b3c...
X-Webhook-Event-Id: evt_...
X-Webhook-Event-Type: agent.run.completed
```

The signature format follows Stripe's well-known convention: `t=<unix timestamp>,v1=<hex HMAC-SHA256>`, where the HMAC is computed over `"${t}.${rawRequestBody}"` using your webhook's secret. Signing the timestamp *into* the HMAC input (not just alongside it) is what makes a captured delivery non-replayable — an attacker can't reuse a valid (timestamp, signature) pair against a different body or a later timestamp.

Node.js verification example:

```js
const crypto = require("crypto");

function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header || "");
  if (!match) return false;
  const [, tsStr, signature] = match;
  const timestamp = Number(tsStr);
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false; // reject stale/replayed deliveries
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b); // constant-time compare
}

// In your webhook handler, use the RAW request body (before any JSON parsing/reformatting) —
// re-serializing and re-signing your own parsed copy will not match.
app.post("/webhooks/autopilon", express.raw({ type: "application/json" }), (req, res) => {
  if (!verify(process.env.AUTOPILON_WEBHOOK_SECRET, req.body, req.get("X-Webhook-Signature"))) {
    return res.status(401).end();
  }
  const event = JSON.parse(req.body);
  // ... handle event.type / event.data
  res.status(200).end();
});
```

Always use the **raw** request body bytes for verification — most frameworks parse JSON before your handler sees it, which will produce a different byte sequence than what was signed.

## Delivery, retries, and dead-lettering

Deliveries run through the platform's existing background Job Manager, not a bespoke webhook queue:

- One delivery attempt per invocation. A non-2xx HTTP response *or* a network-level failure (timeout, DNS failure, connection refused, SSRF-blocked) both count as retryable failures.
- Retries use exponential backoff: `min(2^attempts * 2, 300)` seconds (so roughly 2s, 4s, 8s, 16s, ... capped at 5 minutes between attempts).
- Default max attempts: **3**. After the final failed attempt the delivery is marked dead-lettered — it will not be retried further, and there is currently no automatic re-drive; you'd need to notice the failure (e.g. via `GET /v1/webhooks/:id/deliveries`) and act on your end.
- A webhook that's been deleted or set to `disabled` mid-flight is treated as "give up now," not retried.
- Request timeout per delivery attempt: 10 seconds. Response bodies are truncated to 2000 characters when recorded.

## Testing a webhook

```bash
curl -X POST https://<your-deployment>/api/v1/webhooks/<id>/test \
  -H "Authorization: Bearer ap_live_..."
```

This sends a synchronous `test.ping` event and returns the *real* delivery result immediately (`httpStatus`, `responseTimeMs`, `error` if any) — it is **not** queued through the Job Manager and is **not** recorded in the deliveries history (that history is only for real, event-triggered deliveries). Use this to confirm your receiver is reachable and your signature verification passes before relying on live events.

## Viewing delivery history

```bash
curl "https://<your-deployment>/api/v1/webhooks/<id>/deliveries?limit=50" \
  -H "Authorization: Bearer ap_live_..."
```

Returns up to 200 most recent real deliveries with status, HTTP response code, latency, attempt count, and error (if any). The same view is available in the Developer Console's Webhooks tab.

## Known limitations

- No per-event payload schema documentation beyond "whatever the emitting code passed" — `data`'s shape is stable in practice but not contractually versioned per event type yet.
- No automatic re-drive of dead-lettered deliveries.
- No webhook delivery rate limiting distinct from your account's own outbound behavior — a webhook receiver that goes down will accumulate failed/dead-lettered deliveries but won't be automatically paused.
