import db from "../db.js";
import { recordUsage } from "./billing.js";

// Representative published per-provider rates, in dollars per 1,000,000
// tokens. These are approximate — actual cost depends on the exact model
// an agent is configured to use, and provider pricing changes over time.
// This engine has no live pricing API, so it deliberately uses one
// representative rate per provider rather than trying (and likely failing)
// to track every specific model's exact current price. Labeled as an
// ESTIMATE everywhere it's surfaced, never presented as an exact bill.
const RATES_PER_MILLION_TOKENS = {
  anthropic: { prompt: 3.0, completion: 15.0 },   // Claude Sonnet-class pricing
  openai: { prompt: 0.15, completion: 0.6 },       // GPT-4o-mini-class pricing
  gemini: { prompt: 0.075, completion: 0.3 },      // Gemini Flash-class pricing
};

// Exported (Phase 16) so any call site recording prompt/completion token
// usage can compute and store a real costCents figure on the usage_records
// row at write time — costControls.js's spend-limit checks need a plain
// SUM(costCents) to be accurate, which only works if it's populated
// everywhere a cost is known, not just here.
export function estimateCostCents(provider, promptTokens, completionTokens) {
  const rates = RATES_PER_MILLION_TOKENS[provider] || RATES_PER_MILLION_TOKENS.anthropic;
  const dollars = (promptTokens / 1_000_000) * rates.prompt + (completionTokens / 1_000_000) * rates.completion;
  return Math.round(dollars * 100);
}

// Shared by every text-generation call site (chat's orchestrate(), automation
// step execution, Content Studio's copywriter) so the ai_request + prompt/
// completion token bookkeeping — including splitting the one estimated
// dollar cost proportionally across the two token rows so a plain
// SUM(costCents) adds up exactly, without rounding drift — is written once,
// not reimplemented at each call site with room to drift out of sync.
// recordRequest: false when the caller already records its own "ai_request"
// tally elsewhere for this same generation (Content Studio's copywriter
// does, via createTextAsset()/recordGenerationUsage()) — avoids double-
// counting the request count while still recording the token-level cost,
// which nothing else computes for text generation.
export function recordAiTextUsage(orgId, { provider, promptTokens = 0, completionTokens = 0, agentId = null, userId = null, automationId = null, recordRequest = true }) {
  if (!orgId) return;
  const usageMeta = { provider, agentId, userId };
  const scope = { agentId, userId, automationId };
  if (recordRequest) recordUsage(orgId, "ai_request", 1, usageMeta, scope);
  const totalCostCents = estimateCostCents(provider, promptTokens, completionTokens);
  const promptShare = completionTokens ? Math.round(totalCostCents * (promptTokens / (promptTokens + completionTokens))) : totalCostCents;
  if (promptTokens) recordUsage(orgId, "prompt_tokens", promptTokens, usageMeta, { ...scope, costCents: promptShare });
  if (completionTokens) recordUsage(orgId, "completion_tokens", completionTokens, usageMeta, { ...scope, costCents: totalCostCents - (promptTokens ? promptShare : 0) });
}

function parseMeta(row) {
  try { return JSON.parse(row.metadata || "{}"); } catch { return {}; }
}

// Pulls raw prompt/completion token events for the period and aggregates
// them every way the spec asks for (provider, agent, user, day) — one pass
// over the same rows rather than five separate queries.
export function getCostBreakdown(orgId, { sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const rows = db.prepare(
    `SELECT type, quantity, metadata, createdAt FROM usage_records
     WHERE orgId = ? AND type IN ('prompt_tokens', 'completion_tokens') AND createdAt > ?`
  ).all(orgId, since);

  // BYOK usage isn't a platform cost — the org is paying their own provider
  // directly, not us — so it's tracked for visibility but excluded from the
  // "estimated cost" totals, which represent platform AI spend specifically.
  let totalCents = 0;
  let byokTotalCents = 0;
  const byProvider = {};
  const byAgent = {};
  const byUser = {};
  const byDay = {};

  // Group prompt/completion pairs by (provider, agentId, userId, day) so
  // each request's two token events combine into one cost figure rather
  // than being priced independently (completion tokens cost more per
  // token than prompt tokens, so they can't just be summed and priced flat).
  const buckets = new Map();
  for (const row of rows) {
    const meta = parseMeta(row);
    const day = row.createdAt.slice(0, 10);
    const key = `${meta.provider || "unknown"}|${meta.agentId || "none"}|${meta.userId || "none"}|${day}|${meta.byok ? "byok" : "platform"}`;
    if (!buckets.has(key)) buckets.set(key, { provider: meta.provider || "unknown", agentId: meta.agentId, userId: meta.userId, day, byok: Boolean(meta.byok), promptTokens: 0, completionTokens: 0 });
    const bucket = buckets.get(key);
    if (row.type === "prompt_tokens") bucket.promptTokens += row.quantity;
    else bucket.completionTokens += row.quantity;
  }

  for (const b of buckets.values()) {
    const cents = estimateCostCents(b.provider, b.promptTokens, b.completionTokens);
    if (b.byok) { byokTotalCents += cents; continue; }
    totalCents += cents;
    byProvider[b.provider] = (byProvider[b.provider] || 0) + cents;
    if (b.agentId) byAgent[b.agentId] = (byAgent[b.agentId] || 0) + cents;
    if (b.userId) byUser[b.userId] = (byUser[b.userId] || 0) + cents;
    byDay[b.day] = (byDay[b.day] || 0) + cents;
  }

  // Phase 15 media generation (image/video/audio) isn't token-based — it's
  // a flat per-generation cost already computed and stored directly as
  // costCents on the usage_records row (see contentService.js), not
  // estimated here from a rate table. Folded into the same totals/byAgent/
  // byUser/byDay shape using the real columns added in Phase 16, not
  // metadata parsing. content_text_generation is deliberately excluded —
  // Content Studio copy's actual cost is captured via its own
  // prompt_tokens/completion_tokens events above, so including it here too
  // would double-count the same generation.
  const mediaRows = db.prepare(
    `SELECT costCents, agentId, userId, createdAt FROM usage_records
     WHERE orgId = ? AND type IN ('image_generation', 'video_generation', 'audio_generation') AND createdAt > ? AND costCents > 0`
  ).all(orgId, since);
  for (const row of mediaRows) {
    totalCents += row.costCents;
    byProvider.media = (byProvider.media || 0) + row.costCents;
    if (row.agentId) byAgent[row.agentId] = (byAgent[row.agentId] || 0) + row.costCents;
    if (row.userId) byUser[row.userId] = (byUser[row.userId] || 0) + row.costCents;
    const day = row.createdAt.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + row.costCents;
  }

  const agentNames = Object.keys(byAgent).length
    ? Object.fromEntries(db.prepare(`SELECT id, name FROM agents WHERE id IN (${Object.keys(byAgent).map(() => "?").join(",")})`).all(...Object.keys(byAgent)).map((a) => [a.id, a.name]))
    : {};
  const userNames = Object.keys(byUser).length
    ? Object.fromEntries(db.prepare(`SELECT id, name FROM users WHERE id IN (${Object.keys(byUser).map(() => "?").join(",")})`).all(...Object.keys(byUser)).map((u) => [u.id, u.name]))
    : {};

  return {
    periodDays: sinceDays,
    estimatedCostCents: totalCents,
    byokCostCents: byokTotalCents, // tracked for visibility, not billed by the platform
    byProvider: Object.entries(byProvider).map(([provider, cents]) => ({ provider, cents })).sort((a, b) => b.cents - a.cents),
    byAgent: Object.entries(byAgent).map(([agentId, cents]) => ({ agentId, name: agentNames[agentId] || "Unknown agent", cents })).sort((a, b) => b.cents - a.cents),
    byUser: Object.entries(byUser).map(([userId, cents]) => ({ userId, name: userNames[userId] || "Unknown user", cents })).sort((a, b) => b.cents - a.cents),
    byDay: Object.entries(byDay).map(([day, cents]) => ({ day, cents })).sort((a, b) => a.day.localeCompare(b.day)),
    note: "Estimated from token usage using representative provider rates — not an exact bill. BYOK usage is tracked separately and excluded from the platform cost total.",
  };
}
