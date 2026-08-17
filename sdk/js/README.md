# @autopilon/sdk

A minimal, dependency-free JS/TS client for the [Autopilon Public API](../../PUBLIC_API.md). Not published to npm — install it locally from this repo path. Requires Node 18+ (for global `fetch`/`FormData`), or any modern browser.

A Python SDK is also available — see [`sdk/python/README.md`](../python/README.md).

## Install

```bash
npm install /path/to/autopilon-mobile/sdk/js
# or, from within a monorepo package:
npm install file:../sdk/js
```

## Usage

```js
import { AutopilonClient, AutopilonApiError } from "@autopilon/sdk";

const client = new AutopilonClient({
  apiKey: process.env.AUTOPILON_API_KEY,        // ap_live_...
  baseUrl: "https://your-deployment/api/v1",     // defaults to http://localhost:4000/api/v1
});

// List agents
const { data: agents } = await client.agents.list({ limit: 20 });

// Execute an agent (synchronous)
const run = await client.agents.execute(agents[0].id, { message: "Summarize this week." });
console.log(run.response);

// Execute an agent (async) + poll
const queued = await client.agents.execute(agents[0].id, { message: "Long task...", async: true });
let result = await client.runs.get(queued.id);
while (result.status === "queued" || result.status === "running") {
  await new Promise((r) => setTimeout(r, 1000));
  result = await client.runs.get(queued.id);
}

// Walk every page of a list endpoint without manual cursor handling
for await (const task of client.paginate("/tasks", { query: { limit: 50 } })) {
  console.log(task.title);
}

// Errors carry a stable machine-readable code, not just a message
try {
  await client.agents.get("does-not-exist");
} catch (err) {
  if (err instanceof AutopilonApiError && err.code === "RESOURCE_NOT_FOUND") {
    console.log("No such agent.");
  } else {
    throw err;
  }
}

// Upload a file (Node: pass a Blob, e.g. via `new Blob([buffer])`; browser: pass a File)
const file = await client.files.upload({
  file: new Blob([fileBuffer], { type: "application/pdf" }),
  filename: "report.pdf",
});

// Create a webhook — the response includes the signing secret (shown once
// here; re-fetch it later via client.webhooks.getSecret(id))
const webhook = await client.webhooks.create({
  url: "https://yourapp.com/webhooks/autopilon",
  events: ["agent.run.completed", "agent.run.failed"],
});
console.log(webhook.secret);

// Idempotency-Key — a retried write with the same key and body replays the
// original result instead of running twice. Supported on the write
// endpoints listed in PUBLIC_API.md's Idempotency section.
const task = await client.tasks.create({ title: "Follow up" }, { idempotencyKey: crypto.randomUUID() });

// Integration actions — a curated, explicitly-approved subset of what an
// agent's own tools can do, gated by that agent's enabled skills (same as
// the internal chat pipeline). See PUBLIC_API.md's Integrations section.
const { data: actions } = await client.integrations.listActions("gmail");
const result = await client.integrations.executeAction("gmail", "gmail.list_emails", { agentId: agents[0].id });
```

## What's covered

Every resource documented in [PUBLIC_API.md](../../PUBLIC_API.md): `agents`, `runs`, `automations`, `tasks`, `projects`, `files`, `content`, `integrations` (including the curated `listActions`/`executeAction` methods), `marketplace`, `webhooks`. Nothing beyond that — this SDK does not invent convenience methods for endpoints that don't exist server-side.

## What's not covered

- No automatic retry on `429`/`5xx` — the caller decides its own retry policy. `err.status` and the `Retry-After` semantics documented in PUBLIC_API.md give you what you need to build one.
- No built-in webhook signature verification helper — see [WEBHOOKS.md](../../WEBHOOKS.md#verifying-signatures) for a standalone Node example (deliberately not bundled here, since verification runs on *your* receiving server, not through this client).
- No streaming/chunked upload for `files.upload` — the whole file is buffered into one multipart request, same as the server's own 500 MB limit implies.

## Testing this SDK

This package has no automated test suite of its own yet — it was verified by manual smoke-testing every resource method against a live local server during Phase 17 development (see the Phase 17 completion report for what was actually exercised vs. only code-reviewed).
