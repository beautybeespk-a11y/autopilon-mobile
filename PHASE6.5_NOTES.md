# Phase 6.5 — Event-Driven Automation Completion

## Architecture
```
External Event (WhatsApp msg, Meta tool completing, internal action, webhook)
  ↓
publishEvent(userId, source, eventType, payload, eventId)   [automation/triggers.js]
  — dedupes via (source, eventId) unique index on automation_events
  — matches active automations by triggerType
  — applies each automation's optional filter (condition groups)
  — enqueues matches (never runs them directly)
  ↓
automation_event_queue                                       [automation/eventQueue.js]
  — background tick (every 3s) processes queued jobs
  — retries up to 3 times, then dead-letters
  ↓
runWorkflow()  →  the SAME Workflow Runner, Tool Registry, and Orchestrator
                  built in Phase 6 — nothing here was rewritten
```

## Trigger Manager
`publishEvent()` is the one function every event source calls. It has no
opinion about WhatsApp, Meta, or anything else — a source publishes
`(userId, source, eventType, payload, eventId)` and everything downstream
(dedup, matching, filtering, queueing, logging) is identical regardless of
where the event came from. This is what makes future integrations
(WooCommerce, Gmail, Stripe, etc.) pluggable without touching this file —
they just call the same function.

## Execution Queue — what it is and isn't
A real queue, not fire-and-forget: `automation_event_queue` persists every
job, a background tick processes a batch, failures retry up to 3 times
before dead-lettering. This is genuinely more durable than Phase 5's
webhook processing (which had no retry at all). **What it isn't**: a
distributed queue. There's no Redis/BullMQ in this stack — if the Node
process dies mid-tick, an in-flight job stays `processing` until the next
boot re-picks it up as part of normal queued-job scanning (rows never
silently vanish, but "exactly-once, mid-flight" guarantees don't fully
hold). Honest for personal/small-business scale; not what you'd want
running unattended at real production volume.

## Event sources wired — what's real vs. recognized
**Fully wired, actually firing:**
- **WhatsApp** — every incoming message now also publishes a
  `whatsapp_message` event (added *alongside* the existing, already-tested
  reply flow — nothing about that flow changed). Supports a keyword filter
  in the builder.
- **Meta Ads** — `create_campaign`, `update_campaign`, `pause_campaign`,
  `resume_campaign` each publish a `meta_ads_event` on success, with an
  `eventSubtype` you can filter on. **Important honesty note**: this fires
  because *our own tool call* succeeded — Meta does not push ad-account
  webhooks to this app. There's no live Meta Marketing API webhook
  subscription built. If someone changes a campaign directly in Meta's own
  Ads Manager (not through this app), this app has no way to know.
- **Internal** — `task_created`, `task_completed`, `automation_completed`,
  `automation_failed` (the last two guarded against recursion — see below).
- **External webhooks** — a new secret-authenticated, per-automation
  endpoint (`POST /api/triggers/webhook/:automationId`), with optional
  event-id-based replay protection if the caller supplies one.

**Recognized as valid trigger types, selectable in the builder, but not
yet publishing events:** `ai_chat_request`, `knowledge_update`, `task_due`,
plus several spec-listed WhatsApp sub-events (conversation started/closed,
business-hours boundaries) and Meta sub-events (performance threshold
crossed — this specifically needs a periodic insights-polling job that
doesn't exist yet, since it's not something any single tool call can
detect the moment it happens). Wiring any of these in later is the same
one-line `publishEvent(...)` call added at the point where that event
already happens in the code — the pattern is proven four times over now.

## Recursion guard
`automation_completed`/`automation_failed` only fire for runs whose own
trigger was `manual` or `schedule` — never for a run that was itself
started by an event. Without this, a workflow reacting to "a workflow
finished" could trigger a run whose own completion fires the same event
again, chaining without end.

## Event filters
Extended the condition evaluator (already had equals/contains/greater_than/
less_than/exists/empty from Phase 6) with `starts_with`, `ends_with`, and
`regex` — the three the spec added. AND-within-a-group, OR-across-groups,
same as before; an invalid regex simply never matches rather than crashing
the filter.

## Deduplication
Every event's `(source, eventId)` is a unique index — a WhatsApp retry, a
repeated webhook delivery, or (in principle) a repeated Meta callback all
collide on insert and are silently skipped. Internally-generated events
(task created, automation completed) get a fresh random id each time by
design — there's nothing to redeliver for those, so forcing a stable key
would incorrectly suppress legitimate repeats (e.g., completing the same
kind of task twice should fire twice).

## Database changes
`automation_events` (the event history — source, type, payload, which
automations matched, status) and `automation_event_queue` (the actual
queue: status, attempt count, last error). No changes to any Phase 6
table — automations/steps/runs/logs are untouched.

## API endpoints
- `GET /api/automations/events` — recent event history
- `GET /api/automations/events/stats` — event counts by source
- `GET /api/automations/queue-health` — queued/processing/completed/failed/dead-lettered counts
- `POST /api/triggers/webhook/:automationId` — the external trigger endpoint
  (secret via `x-webhook-secret` header or `?secret=` query param)

## Security
- Webhook secret is generated server-side (never client-guessable), checked
  with a direct string comparison against the stored value per automation.
- The external webhook endpoint is scoped to exactly one automation ID —
  it can't be used to enumerate or fire someone else's workflows.
- Meta/WhatsApp events still go through the existing Phase 4/5 signature
  verification before ever reaching `publishEvent` — this phase adds event
  publishing after that trust boundary, not instead of it.

## A mistake I caught mid-build
A `str_replace` while wiring the `create_campaign` event accidentally
deleted the `update_campaign` tool's `registerTool({ name: ...` header line.
Caught immediately by the same `node --check` discipline used throughout
this project, before it was ever packaged — worth mentioning so you know
the syntax-check step isn't just theater.

## Test results — same honesty note as every phase
Every file passes `node --check`. **None of this has been run.** The
riskiest untested paths: whether the queue tick actually drains jobs at the
promised 3-second interval in a real Node process, whether the WhatsApp
event fires correctly alongside the existing reply (should be additive and
safe, but "should" isn't "verified"), and whether a filter you build in the
UI (e.g. a WhatsApp keyword) actually matches real incoming message text
the way the condition evaluator expects it to.

## Production readiness
Architecturally sound and consistent with every phase before it — but the
in-process queue, the "our-own-action" framing of Meta events (not a true
Meta webhook subscription), and several still-inert trigger types are real
gaps before this runs unattended at real scale. The pattern for closing
each of them is now proven and repeatable.
