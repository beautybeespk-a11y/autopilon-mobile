import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createNotification } from "./notifications.js";

const now = () => new Date().toISOString();
const currentPeriod = () => new Date().toISOString().slice(0, 7); // 'YYYY-MM'

// Structural limits (users/agents/automations/integrations) are hard —
// blocking new creation past the limit is the whole point of a plan
// boundary. AI request volume is soft — hard-blocking someone mid-workflow
// because they hit a request count would be a worse experience than
// letting the request through and making sure they know they're over,
// same as how most real usage-based SaaS products handle overage.
const SOFT_QUOTA_TYPES = new Set(["maxAiRequests"]);
const WARNING_THRESHOLDS = [100, 90, 75, 50]; // checked highest-first so only the highest crossed threshold notifies

function periodBounds() {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
  return { start, end };
}

export function getPlan(planId) {
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
}

export function listPlans() {
  return db.prepare("SELECT * FROM plans ORDER BY monthlyPriceCents ASC").all();
}

// Every organization gets a Free subscription the moment it's created —
// there's no "no subscription" state for an org, only "on the Free plan."
// This keeps every quota check below simple (always a real plan to compare
// against) instead of needing a null-subscription special case everywhere.
export function ensureSubscription(orgId) {
  const existing = db.prepare("SELECT * FROM subscriptions WHERE orgId = ?").get(orgId);
  if (existing) return existing;
  const { start, end } = periodBounds();
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO subscriptions (id, orgId, planId, status, billingMode, currentPeriodStart, currentPeriodEnd, createdAt, updatedAt)
     VALUES (?, ?, 'free', 'active', 'platform_managed', ?, ?, ?, ?)`
  ).run(id, orgId, start, end, now(), now());
  return db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id);
}

export function getSubscription(orgId) {
  return db.prepare("SELECT * FROM subscriptions WHERE orgId = ?").get(orgId) || null;
}

export function getSubscriptionWithPlan(orgId) {
  const sub = getSubscription(orgId);
  if (!sub) return null;
  return { ...sub, plan: getPlan(sub.planId) };
}

export function setPlan(orgId, planId) {
  const plan = getPlan(planId);
  if (!plan) throw new Error(`Unknown plan "${planId}".`);
  ensureSubscription(orgId);
  db.prepare("UPDATE subscriptions SET planId = ?, updatedAt = ? WHERE orgId = ?").run(planId, now(), orgId);
  return getSubscriptionWithPlan(orgId);
}

export function setBillingMode(orgId, mode) {
  if (!["platform_managed", "byok"].includes(mode)) throw new Error("billingMode must be 'platform_managed' or 'byok'.");
  ensureSubscription(orgId);
  db.prepare("UPDATE subscriptions SET billingMode = ?, updatedAt = ? WHERE orgId = ?").run(mode, now(), orgId);
  return getSubscriptionWithPlan(orgId);
}

// --- Usage ---

function usageColumnFor(type) {
  return { ai_request: "aiRequests", prompt_tokens: "promptTokens", completion_tokens: "completionTokens",
    automation_execution: "automationExecutions", tool_call: "toolCalls", api_call: "apiCalls" }[type];
}

export function recordUsage(orgId, type, quantity = 1, metadata = null) {
  if (!orgId) return; // no org context — nothing to meter, by design
  const column = usageColumnFor(type);
  if (!column) throw new Error(`Unknown usage type "${type}".`);
  db.prepare("INSERT INTO usage_records (id, orgId, type, quantity, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(cryptoRandom(), orgId, type, quantity, metadata ? JSON.stringify(metadata) : null, now());
  const period = currentPeriod();
  db.prepare(
    `INSERT INTO organization_usage (orgId, period, ${column}, updatedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(orgId, period) DO UPDATE SET ${column} = ${column} + excluded.${column}, updatedAt = excluded.updatedAt`
  ).run(orgId, period, quantity, now());
}

export function getUsage(orgId, period = currentPeriod()) {
  return (
    db.prepare("SELECT * FROM organization_usage WHERE orgId = ? AND period = ?").get(orgId, period) ||
    { orgId, period, aiRequests: 0, promptTokens: 0, completionTokens: 0, automationExecutions: 0, toolCalls: 0, apiCalls: 0 }
  );
}

// Live COUNT-based checks (agents/automations/integrations/users) rather
// than the incremental usage rollup — these are current totals, not
// period-based events, so "how many do you have right now" is the only
// correct question, not "how many were created this month."
function currentCount(orgId, table, extraWhere = "") {
  return db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE orgId = ? ${extraWhere}`).get(orgId).c;
}

// Returns { allowed, limit, current, remaining }. limit === null means
// unlimited (Enterprise, or a plan field left NULL) — always allowed.
export function checkQuota(orgId, quotaType) {
  const sub = getSubscriptionWithPlan(orgId);
  if (!sub) return { allowed: true, limit: null, current: 0, remaining: null, percentUsed: 0, warningLevel: null, isSoft: SOFT_QUOTA_TYPES.has(quotaType) }; // no org context — unmetered
  const plan = sub.plan;

  const checks = {
    maxUsers: () => currentCount(orgId, "organization_members", "AND status != 'suspended'"),
    maxAgents: () => currentCount(orgId, "agents"),
    maxAutomations: () => currentCount(orgId, "automations"),
    maxIntegrations: () => db.prepare("SELECT COUNT(*) c FROM integrations WHERE orgId = ? AND status = 'connected'").get(orgId).c,
    maxAiRequests: () => getUsage(orgId).aiRequests,
  };
  const getCurrent = checks[quotaType];
  if (!getCurrent) throw new Error(`Unknown quota type "${quotaType}".`);
  const limit = plan[quotaType];
  const current = getCurrent();
  const isSoft = SOFT_QUOTA_TYPES.has(quotaType);
  if (limit == null) return { allowed: true, limit: null, current, remaining: null, percentUsed: 0, warningLevel: null, isSoft };

  const percentUsed = Math.round((current / limit) * 100);
  const warningLevel = WARNING_THRESHOLDS.find((t) => percentUsed >= t) || null;
  // A soft quota is always "allowed" (never blocks) — being over it just
  // means the warningLevel hits 100 and stays there. A hard quota blocks
  // once current reaches the limit, same as before this was added.
  const allowed = isSoft ? true : current < limit;
  return { allowed, limit, current, remaining: Math.max(limit - current, 0), percentUsed, warningLevel, isSoft };
}

// Sends at most one notification per (org, billing period, quota type,
// threshold) — checked highest-first so crossing straight from 40% to 95%
// in one jump only sends the 90% warning, not four separate ones.
function maybeWarnQuota(orgId, quotaType, label, result) {
  if (!result.warningLevel) return;
  const period = currentPeriod();
  const alreadySent = db.prepare(
    "SELECT 1 FROM quota_warnings_sent WHERE orgId = ? AND period = ? AND quotaType = ? AND threshold = ?"
  ).get(orgId, period, quotaType, result.warningLevel);
  if (alreadySent) return;

  db.prepare("INSERT OR IGNORE INTO quota_warnings_sent (orgId, period, quotaType, threshold, sentAt) VALUES (?, ?, ?, ?, ?)")
    .run(orgId, period, quotaType, result.warningLevel, now());

  const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
  if (!org) return;
  const title = result.warningLevel >= 100
    ? `${label} limit reached for "${org.name}"`
    : `${label} at ${result.warningLevel}% for "${org.name}"`;
  const body = result.isSoft && result.warningLevel >= 100
    ? `You're over your plan's ${label} limit (${result.current}/${result.limit}). Requests still work, but consider upgrading.`
    : `${result.current} of ${result.limit} used this period.`;
  createNotification(org.ownerId, { type: "quota_warning", title, body, link: `/app/organizations/${orgId}` });
}

// Throws a clear, user-facing error if over a HARD quota; for soft quotas,
// never throws — just makes sure a warning notification goes out at each
// threshold crossed. The shape every write path below calls before
// creating the thing being limited (or, for AI requests, before each call).
export function enforceQuota(orgId, quotaType, label) {
  if (!orgId) return; // personal/individual — no quota applies
  const result = checkQuota(orgId, quotaType);
  maybeWarnQuota(orgId, quotaType, label, result);
  if (!result.allowed) {
    const err = new Error(`Your organization's plan allows up to ${result.limit} ${label}. Upgrade your plan to add more.`);
    err.code = "QUOTA_EXCEEDED";
    throw err;
  }
}

export function getBillingDashboard(orgId) {
  const sub = getSubscriptionWithPlan(orgId);
  const usage = getUsage(orgId);
  const quotas = ["maxUsers", "maxAgents", "maxAutomations", "maxIntegrations", "maxAiRequests"].map((type) => ({
    type, ...checkQuota(orgId, type),
  }));
  return { subscription: sub, usage, quotas };
}
