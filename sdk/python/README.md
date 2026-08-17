# autopilon-sdk (Python)

A minimal, dependency-free Python client for the [Autopilon Public API](../../PUBLIC_API.md). Not published to PyPI — install it locally from this repo path. Built entirely on the standard library (`urllib`) — nothing to `pip install` beyond Python 3.8+ itself.

There's also a [JS/TS SDK](../js/README.md) covering the same surface.

## Install

```bash
pip install /path/to/autopilon-mobile/sdk/python
# or, for local development against this repo:
pip install -e /path/to/autopilon-mobile/sdk/python
```

## Usage

```python
import os
from autopilon import AutopilonClient, AutopilonApiError

client = AutopilonClient(
    api_key=os.environ["AUTOPILON_API_KEY"],       # ap_live_...
    base_url="https://your-deployment/api/v1",      # defaults to http://localhost:4000/api/v1
)

# List agents
agents = client.agents.list(limit=20)["data"]

# Execute an agent (synchronous)
run = client.agents.execute(agents[0]["id"], message="Summarize this week.")
print(run["response"])

# Execute an agent (async) + poll
queued = client.agents.execute(agents[0]["id"], message="Long task...", run_async=True)
result = client.runs.get(queued["id"])
while result["status"] in ("queued", "running"):
    import time; time.sleep(1)
    result = client.runs.get(queued["id"])

# Walk every page of a list endpoint without manual cursor handling
for task in client.paginate("/tasks", query={"limit": 50}):
    print(task["title"])

# Errors carry a stable machine-readable code, not just a message
try:
    client.agents.get("does-not-exist")
except AutopilonApiError as err:
    if err.code == "RESOURCE_NOT_FOUND":
        print("No such agent.")
    else:
        raise

# Upload a file
with open("report.pdf", "rb") as f:
    file_obj = client.files.upload(f.read(), filename="report.pdf", content_type="application/pdf")

# Create a webhook — the response includes the signing secret (shown once
# here; re-fetch it later via client.webhooks.get_secret(id))
webhook = client.webhooks.create(
    url="https://yourapp.com/webhooks/autopilon",
    events=["agent.run.completed", "agent.run.failed"],
)
print(webhook["secret"])

# Idempotency-Key — a retried write with the same key and body replays the
# original result instead of running twice.
import uuid
task = client.tasks.create(title="Follow up", idempotency_key=str(uuid.uuid4()))

# Integration actions — a curated, explicitly-approved subset of what an
# agent's own tools can do, gated by that agent's enabled skills.
actions = client.integrations.list_actions("gmail")["data"]
result = client.integrations.execute_action("gmail", "gmail.list_emails", agent_id=agents[0]["id"])
```

## What's covered

Every resource documented in [PUBLIC_API.md](../../PUBLIC_API.md): `agents`, `runs`, `automations`, `tasks`, `projects`, `files`, `content`, `integrations` (including `list_actions`/`execute_action`), `marketplace`, `webhooks`. Nothing beyond that — this SDK does not invent convenience methods for endpoints that don't exist server-side.

## What's not covered

- No automatic retry on `429`/`5xx` — the caller decides its own retry policy. `err.status` and the `Retry-After` semantics documented in PUBLIC_API.md give you what you need to build one.
- No built-in webhook signature verification helper — see [WEBHOOKS.md](../../WEBHOOKS.md#verifying-signatures) for a standalone example (verification runs on *your* receiving server, not through this client). A Python translation is straightforward: `hmac.new(secret.encode(), f"{timestamp}.{raw_body}".encode(), "sha256").hexdigest()`, compared with `hmac.compare_digest`.
- No streaming/chunked upload for `files.upload` — the whole file is buffered into one multipart request in memory, same as the server's own 500 MB limit implies.
- No async/await client (this uses blocking `urllib` calls) — wrap calls in a thread pool or `asyncio.to_thread` if you need concurrency.

## Testing this SDK

`smoke_test.py` is a real, runnable script (not a pytest suite — this SDK has zero dependencies, including for its own tests) that exercises every resource against a live local server with real fixtures:

```bash
AUTOPILON_API_KEY=ap_live_... AUTOPILON_BASE_URL=http://localhost:4000/api/v1 python3 smoke_test.py
```

It was run against a real booted server during Phase 17.1 development — see the Phase 17.1 section of [PHASE17_NOTES.md](../../PHASE17_NOTES.md) for the actual pass/fail results, not just a claim that it works.
