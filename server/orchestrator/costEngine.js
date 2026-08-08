import db from "../db.js";

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

function estimateCostCents(provider, promptTokens, completionTokens) {
  const rates = RATES_PER_MILLION_TOKENS[provider] || RATES_PER_MILLION_TOKENS.anthropic;
  const dollars = (promptTokens / 1_000_000) * rates.prompt + (completionTokens / 1_000_000) * rates.completion;
  return Math.round(dollars * 100);
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
