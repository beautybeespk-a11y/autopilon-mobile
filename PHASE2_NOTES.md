# Phase 2 — Internal Productivity Tools + AI Orchestrator

## 1. What was built
A real orchestration layer sits between AI Chat and the database. The AI no
longer just replies — it can decide to call a tool, and the backend actually
runs it, subject to permission checks and (for sensitive actions) explicit
user approval.

## 2. Orchestrator architecture
`server/orchestrator/index.js` — `orchestrate()`:
1. Loads the selected agent's enabled skills → the tools available to it.
2. Builds a system prompt listing those tools with their parameter schemas.
3. Asks the AI provider for a **structured JSON decision**: `final`,
   `tool_call`, or `plan` (multi-step).
4. Runs any tool calls through the executor, one at a time, feeding each
   result back to the model so it can decide the next step or summarize.
5. Stops at a hard step ceiling (5) so a confused plan can't loop forever.
6. Returns `{ reply, trace, toolResults, confirmation }` — `trace` drives the
   `ToolActivity` rail in the UI.

## 3. Tool Registry architecture
`server/tools/registry.js` holds every tool: name, description, category
(maps to a skill id), parameter schema, required permissions, whether it
needs confirmation, and its `execute` function. Nothing outside the registry
runs tool logic — the chat route only talks to the orchestrator, which only
talks to the registry/executor. Adding a tool later means: write a file,
`registerTool({...})`, import it in `tools/index.js`. No other file changes.

## 4. Tools created
- `create_task`, `list_tasks`, `update_task`, `complete_task` (skill:
  productivity, permissions: tasks.read/tasks.write, no confirmation)
- `create_memory` (skill: memory, permission: memory.write, **confirmation
  required**), `list_memories` (memory.read), `delete_memory`
  (memory.delete, **confirmation required**)
All task/memory tools verify the record belongs to the authenticated user
before reading, updating, or deleting it.

## 5. Skills connected
Two skill ids gate tool access: `productivity` (task tools) and `memory`
(memory tools). An agent only gets a tool if that skill is enabled on it in
the Agent Builder. Agents with neither skill can still chat normally — they
just won't have tools offered to the model.

## 6. Permission system
`server/orchestrator/permissions.js`. Every authenticated user implicitly
holds the base permission set (`tasks.read`, `tasks.write`, `memory.read`,
`memory.write`, `memory.delete`) since there's no multi-tenant model yet.
An `agent_permissions` table exists for future per-agent restrictions
(e.g. an agent allowed to read tasks but not delete memories) without
another migration.

## 7. Confirmation system
`server/orchestrator/executor.js` + `server/routes/confirmations.js`.
A confirmation-gated tool call stops at `awaiting_confirmation` and is
**not executed**. A `confirmation_requests` row is created (15-minute
expiry). The frontend renders Approve/Reject buttons; only
`POST /api/confirmations/:id/approve` or `/reject`, checked server-side
against the authenticated user and expiry, resumes execution. The frontend's
approval click is never trusted on its own — the backend re-validates
ownership and status before doing anything.

## 8. Database changes
Added: `execution_plans`, `tool_executions`, `confirmation_requests`,
`agent_permissions`. Added `messages.meta` (JSON: trace + toolResults +
confirmation) so the trace rail survives a page refresh. Seeded a new
`memory` skill.

## 9. API endpoints
- `POST /api/chat/message` — now routes through the orchestrator; response
  includes `trace`, `toolResults`, `confirmation`.
- `POST /api/confirmations/:id/approve` / `/reject` — resolves a pending
  confirmation and resumes execution.

## 10. Tool execution lifecycle
`pending → planning → (awaiting_confirmation) → running → completed|failed`,
tracked per-row in `tool_executions` with timestamps and JSON result/error.

## 11. Test results — IMPORTANT, read before trusting this
I wrote and syntax-checked every new/changed file (`node --check` passes on
all of them — see terminal output). **I have not run this end-to-end**,
because this sandbox has no network access to `npm install` dependencies or
boot the server. None of the 24 scenarios in the spec's Testing section have
actually been executed by me. This is a materially bigger risk than Phase 1:
Phase 1 was mostly UI plumbing, but the orchestrator's JSON-parsing of the
AI's decisions, the multi-step loop, and the confirmation resume path are
exactly the kind of logic that tends to have a bug on first real run.

## 12. Known risks worth watching on first test
- The model may not reliably return raw JSON (some models wrap it in prose
  despite instructions). `safeParseDecision()` falls back to treating any
  unparseable text as a plain final answer, so it shouldn't crash — but
  tool calls could silently fail to trigger if the model ignores the format.
- `gpt-4o-mini` (your current model) is generally good at instruction-
  following for this, but hasn't been verified against this exact prompt.
- The step-result feedback loop re-sends full history each turn; on a long
  conversation this will grow token usage — fine for testing, worth revisiting
  before heavy use.

## 13. Security notes
- Every tool re-checks ownership (userId) at execution time, not just at the
  API boundary.
- Confirmation approval is validated server-side against the authenticated
  session and the confirmation's own expiry/status — never trusted from the
  client alone.
- No secrets are ever written into `tool_executions` or `confirmation_requests`.

## 14. Ready for next phase?
Architecturally yes — Web Search, Meta Ads, Gmail, etc. can each be added as
a new file in `server/tools/` with a new skill id, without touching the
orchestrator. But this phase needs a real test pass first (see #11) before
building further on top of it.
