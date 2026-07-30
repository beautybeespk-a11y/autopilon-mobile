# Phase 3 — Web Research & Knowledge Engine

## Architecture summary
Extends Phase 2's Orchestrator/Tool Registry — no changes to that core loop
except raising the step ceiling (5→8, research chains more steps than a
single task action) and adding research-specific guidance to the system
prompt (cite sources, separate facts from AI analysis, ask before saving).
All new capability is new tools + one new table; nothing was hardcoded into
the chat route.

## New tools (all under the `research` skill)
- `web_search(query)` — provider-agnostic search, no confirmation
- `read_webpage(url)` — dependency-free HTML extraction (title, headings,
  main text, best-effort publish date/author), no confirmation
- `generate_report(topic, findings[])` — calls the AI provider to synthesize
  findings into a structured report (executive summary, key findings,
  statistics, pros, cons, market insights, recommendations, sources), no
  confirmation (nothing is persisted yet)
- `save_research(title, category, tags, content, sourceUrls)` —
  **requires confirmation**, writes to the Knowledge Library
- `search_knowledge(query)` / `list_saved_research()` — read the user's own
  saved items, no confirmation
- `delete_saved_research(itemId)` — **requires confirmation**, ownership
  checked before deletion

## Search provider abstraction
`server/tools/research/providers/index.js` mirrors the AI provider pattern
exactly: `SEARCH_PROVIDER` env var picks tavily/brave/serpapi, each a small
adapter file. Missing key → the tool throws a clear "not configured" error,
caught by the Phase 2 executor and surfaced as a failed step, never a fake
result. Adding a fourth provider is one new file + one registry line — the
Orchestrator never changes.

## Database changes
One new table: `knowledge_items` (type, title, category, tags, content,
sourceUrls, owner, createdAt). Deliberately one flexible table instead of
the four suggested in the spec (research_reports / saved_sources /
knowledge_library / research_history) — reports, notes, saved URLs, and
summaries all share the same shape, so a `type` discriminator does the job
without near-duplicate schemas. "Research History" isn't a separate table:
every web_search/read_webpage/generate_report call already gets logged in
Phase 2's `tool_executions` table per user, per conversation, with a
timestamp — that already *is* research history.
Seeded skill "research" (existed since Phase 1 as a placeholder; description
now reflects what it actually does) and extended the base permission set
with research.read/write and knowledge.read/write/delete.

## API endpoints
- Tool calls happen only through `/api/chat/message` → Orchestrator, as before.
- `GET /api/research/knowledge` / `GET /api/research/knowledge/:id` /
  `DELETE /api/research/knowledge/:id` — direct browse/delete for the
  Knowledge page in the UI (ownership-checked; this is the user looking at
  their own data, not an AI-initiated action, so it doesn't need the chat
  confirmation flow — same as how Tasks works).

## Permission model
research.read (search/read/generate/list), knowledge.read (search/list),
knowledge.write (save — confirmation-gated), knowledge.delete (delete —
confirmation-gated). Same enforcement path as Phase 2: `toolAvailableToAgent`
checks the agent has the `research` skill enabled, then each permission.

## Test results — same honesty note as Phase 1 and 2
Every new/changed file passes `node --check`. **None of this has been run.**
This sandbox still has no network to install dependencies or boot the
server, so zero of the spec's test scenarios (web search, page reading,
report generation, saving, retrieval, deletion, permission checks,
isolation, trace events, persistence, error handling) have been executed by
me. This phase carries more first-run risk than Phase 2: `generate_report`
depends on the AI reliably returning structured JSON for its report shape
(same risk class as the orchestrator's own decision parsing), and
`read_webpage`'s regex-based extraction hasn't been tried against a real
page yet — it may need tuning per-site once you see actual output.

## Known issues / things to watch on first real test
- **No search provider is configured yet.** Until `SEARCH_PROVIDER` +
  a matching key are set, `web_search` will fail cleanly with "Web search
  provider not configured" — that's correct behavior, not a bug, but it
  means nothing research-related will work until you add a Tavily/Brave/
  SerpAPI key.
- `read_webpage` has no JS-rendering — sites that need JavaScript to show
  content will return thin or empty extracts.
- `generate_report`'s JSON parsing falls back to dumping raw text into
  `executiveSummary` if the model doesn't return valid JSON — better than
  crashing, but the report will look degraded until confirmed working.
- Your existing agents won't have the Research skill enabled automatically
  (unlike Phase 2's one-time backfill, this isn't a bug to patch — just use
  the Edit button on My Agents to turn it on, same as you did for
  Productivity/Memory).

## Security notes
- Every knowledge_items query/delete checks `userId` ownership, both in the
  AI-tool path and the direct browse API.
- No API keys or secrets are ever written into `tool_executions`,
  `confirmation_requests`, or `knowledge_items`.
- `read_webpage` fetches whatever URL the AI/tool call supplies — there's no
  allowlist. Treat this the same as any SSRF-adjacent surface: fine for
  personal testing, worth restricting before exposing this to other users.

## Ready for Phase 4?
Architecturally yes — Meta Ads, Gmail, Drive, WooCommerce, WordPress can
each be added as new files in server/tools/ with their own skill id, exactly
like Phase 3 was added on top of Phase 2, without touching the Orchestrator.
But get a search provider key configured and actually run the three test
prompts first — that's the real gate, not this document.
