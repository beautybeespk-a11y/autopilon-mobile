// Org-level AI spend safeguards (Phase 16 §40) — daily/monthly/per-agent/
// per-user/per-automation ceilings, all optional and unset (unlimited) by
// default. Reads real cost from usage_records.costCents (populated at
// write time by recordUsage()'s scope param — see costEngine.js's
// recordAiTextUsage() for text, contentService.js's recordGenerationUsage()
// for image/voiceover) via plain SQL SUM, not the token-rate estimation
// costEngine.js's getCostBreakdown() does — this needs to be cheap enough
// to run before every generation, not a report.
import db from "../db.js";
import { createNotification } from "./notifications.js";

const now = () => new Date().toISOString();

const DEFAULT_LIMITS = { dailyLimitCents: null, monthlyLimitCents: null, perAgentLimitCents: null, perUserLimitCents: null, perAutomationLimitCents: null, alertThresholdPercent: 80 };

export function getSpendLimits(orgId) {
  const row = db.prepare("SELECT * FROM organization_spend_limits WHERE orgId = ?").get(orgId);
  return row ? { ...DEFAULT_LIMITS, ...row } : { orgId, ...DEFAULT_LIMITS, updatedAt: null };
}

export function setSpendLimits(orgId, patch) {
  const current = getSpendLimits(orgId);
  const next = {
    dailyLimitCents: patch.dailyLimitCents !== undefined ? patch.dailyLimitCents : current.dailyLimitCents,
    monthlyLimitCents: patch.monthlyLimitCents !== undefined ? patch.monthlyLimitCents : current.monthlyLimitCents,
    perAgentLimitCents: patch.perAgentLimitCents !== undefined ? patch.perAgentLimitCents : current.perAgentLimitCents,
    perUserLimitCents: patch.perUserLimitCents !== undefined ? patch.perUserLimitCents : current.perUserLimitCents,
    perAutomationLimitCents: patch.perAutomationLimitCents !== undefined ? patch.perAutomationLimitCents : current.perAutomationLimitCents,
    alertThresholdPercent: patch.alertThresholdPercent !== undefined ? Math.max(1, Math.min(100, patch.alertThresholdPercent)) : current.alertThresholdPercent,
  };
  db.prepare(
    `INSERT INTO organization_spend_limits (orgId, dailyLimitCents, monthlyLimitCents, perAgentLimitCents, perUserLimitCents, perAutomationLimitCents, alertThresholdPercent, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(orgId) DO UPDATE SET dailyLimitCents = excluded.dailyLimitCents, monthlyLimitCents = excluded.monthlyLimitCents,
       perAgentLimitCents = excluded.perAgentLimitCents, perUserLimitCents = excluded.perUserLimitCents,
       perAutomationLimitCents = excluded.perAutomationLimitCents, alertThresholdPercent = excluded.alertThresholdPercent, updatedAt = excluded.updatedAt`
  ).run(orgId, next.dailyLimitCents, next.monthlyLimitCents, next.perAgentLimitCents, next.perUserLimitCents, next.perAutomationLimitCents, next.alertThresholdPercent, now());
  return getSpendLimits(orgId);
}

function startOfDayIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}
function startOfMonthIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function spendSince(orgId, sinceIso, extraWhere = "", extraParams = []) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(costCents), 0) c FROM usage_records WHERE orgId = ? AND createdAt >= ? ${extraWhere}`
  ).get(orgId, sinceIso, ...extraParams);
  return row.c;
}

// Sends at most one alert per (org, scope, day) crossing the threshold —
// same dedup shape as billing.js's maybeWarnQuota, kept separate since this
// tracks a different kind of threshold (dollars, not a count) with its own
// scopes (daily/monthly/agent/user/automation).
function maybeAlert(orgId, scopeKey, current, limit, thresholdPercent) {
  if (!limit) return;
  const percentUsed = Math.round((current / limit) * 100);
  if (percentUsed < thresholdPercent) return;
  const day = new Date().toISOString().slice(0, 10);
  const alertKey = `spend:${scopeKey}`;
  const already = db.prepare(
    "SELECT 1 FROM quota_warnings_sent WHERE orgId = ? AND period = ? AND quotaType = ? AND threshold = ?"
  ).get(orgId, day, alertKey, percentUsed >= 100 ? 100 : thresholdPercent);
  if (already) return;
  db.prepare("INSERT OR IGNORE INTO quota_warnings_sent (orgId, period, quotaType, threshold, sentAt) VALUES (?, ?, ?, ?, ?)")
    .run(orgId, day, alertKey, percentUsed >= 100 ? 100 : thresholdPercent, now());
  const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
  if (!org) return;
  const label = scopeKey.split(":")[0];
  createNotification(org.ownerId, {
    type: "spend_alert",
    title: percentUsed >= 100 ? `AI spend limit reached for "${org.name}"` : `AI spend at ${percentUsed}% for "${org.name}"`,
    body: `${label} spend: $${(current / 100).toFixed(2)} of $${(limit / 100).toFixed(2)}.`,
    link: `/app/organizations/${orgId}`,
  });
}

// Throws QUOTA_EXCEEDED if any applicable, already-configured limit is
// currently at or over its ceiling. Checked BEFORE the provider call, same
// principle as enforceQuota() — a limit that only warns after the money's
// already spent isn't a spend control. Cheap no-op when nothing is
// configured for this org (the common case): one indexed row lookup, no
// SUM queries at all.
export function enforceSpendLimit(orgId, { agentId, userId, automationId } = {}) {
  if (!orgId) return;
  const limits = getSpendLimits(orgId);
  const hasAnyLimit = limits.dailyLimitCents || limits.monthlyLimitCents || limits.perAgentLimitCents || limits.perUserLimitCents || limits.perAutomationLimitCents;
  if (!hasAnyLimit) return;

  const checks = [];
  if (limits.dailyLimitCents) checks.push({ key: "daily", limit: limits.dailyLimitCents, spend: () => spendSince(orgId, startOfDayIso()) });
  if (limits.monthlyLimitCents) checks.push({ key: "monthly", limit: limits.monthlyLimitCents, spend: () => spendSince(orgId, startOfMonthIso()) });
  if (limits.perAgentLimitCents && agentId) checks.push({ key: `agent:${agentId}`, limit: limits.perAgentLimitCents, spend: () => spendSince(orgId, startOfMonthIso(), "AND agentId = ?", [agentId]) });
  if (limits.perUserLimitCents && userId) checks.push({ key: `user:${userId}`, limit: limits.perUserLimitCents, spend: () => spendSince(orgId, startOfMonthIso(), "AND userId = ?", [userId]) });
  if (limits.perAutomationLimitCents && automationId) checks.push({ key: `automation:${automationId}`, limit: limits.perAutomationLimitCents, spend: () => spendSince(orgId, startOfMonthIso(), "AND automationId = ?", [automationId]) });

  for (const check of checks) {
    const current = check.spend();
    maybeAlert(orgId, check.key, current, check.limit, limits.alertThresholdPercent);
    if (current >= check.limit) {
      const err = new Error(`This organization's AI spend limit (${check.key}: $${(check.limit / 100).toFixed(2)}) has been reached. An org owner/admin can raise it in Organization Settings.`);
      err.code = "QUOTA_EXCEEDED";
      throw err;
    }
  }
}

export function getSpendStatus(orgId) {
  const limits = getSpendLimits(orgId);
  return {
    limits,
    dailySpendCents: spendSince(orgId, startOfDayIso()),
    monthlySpendCents: spendSince(orgId, startOfMonthIso()),
  };
}
