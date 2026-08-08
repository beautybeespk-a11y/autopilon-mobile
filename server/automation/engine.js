import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { computeNextRun } from "./scheduler.js";
import { getMembership, hasPermission } from "../orchestrator/rbac.js";
import { enforceQuota } from "../orchestrator/billing.js";

const now = () => new Date().toISOString();

// Same three-tier scope as Shared Agents: Personal (orgId NULL, unchanged
// default), Organization (any active member), Workspace (only that
// workspace's members). Sharing means visibility/editing rights over the
// automation's definition — executions still run under the automation's
// OWNING userId's connected integrations, same boundary as Shared Agents;
// true cross-user resource sharing is the separate Shared Integrations slice.
export function automationScope(automation) {
  if (!automation.orgId) return "personal";
  return automation.workspaceId ? "workspace" : "organization";
}

export function canAccessAutomation(userId, automation) {
  if (!automation) return false;
  if (automation.userId === userId) return true;
  if (!automation.orgId) return false;
  const membership = getMembership(automation.orgId, userId);
  if (!membership) return false;
  if (!automation.workspaceId) return true;
  return Boolean(db.prepare("SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(automation.workspaceId, userId));
}

export function canManageAutomation(userId, automation) {
  if (!automation) return false;
  if (automation.userId === userId) return true;
  if (!automation.orgId) return false;
  return hasPermission(automation.orgId, userId, "automation");
}

export function listAutomations(userId) {
  const personal = db.prepare("SELECT * FROM automations WHERE userId = ? AND orgId IS NULL ORDER BY createdAt DESC").all(userId);
  const orgIds = db.prepare("SELECT orgId FROM organization_members WHERE userId = ? AND status = 'active'").all(userId).map((r) => r.orgId);
  if (!orgIds.length) return personal;
  const orgWide = db.prepare(
    `SELECT * FROM automations WHERE orgId IN (${orgIds.map(() => "?").join(",")}) AND workspaceId IS NULL ORDER BY createdAt DESC`
  ).all(...orgIds);
  const workspaceIds = db.prepare("SELECT workspaceId FROM workspace_members WHERE userId = ?").all(userId).map((r) => r.workspaceId);
  const workspaceScoped = workspaceIds.length
    ? db.prepare(`SELECT * FROM automations WHERE workspaceId IN (${workspaceIds.map(() => "?").join(",")})`).all(...workspaceIds)
    : [];
  const seen = new Set();
  return [...personal, ...orgWide, ...workspaceScoped].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

export function getAutomation(userId, id) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  if (!automation || !canAccessAutomation(userId, automation)) return null;
  const steps = db.prepare("SELECT * FROM automation_steps WHERE automationId = ? ORDER BY stepOrder ASC").all(id);
  return { ...automation, steps: steps.map((s) => ({ ...s, config: JSON.parse(s.config || "{}") })) };
}

function replaceSteps(automationId, steps) {
  db.prepare("DELETE FROM automation_steps WHERE automationId = ?").run(automationId);
  const insert = db.prepare(
    "INSERT INTO automation_steps (id, automationId, stepOrder, type, config, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
  );
  (steps || []).forEach((step, i) => {
    insert.run(cryptoRandom(), automationId, i, step.type, JSON.stringify(step.config || {}), now());
  });
}

function snapshotOf(automation, steps) {
  return {
    name: automation.name, description: automation.description, triggerType: automation.triggerType,
    triggerConfig: JSON.parse(automation.triggerConfig || "{}"), variables: JSON.parse(automation.variables || "{}"),
    agentId: automation.agentId, orgId: automation.orgId, workspaceId: automation.workspaceId,
    steps: steps || [],
  };
}

function recordVersion(automationId, version, snapshot, note) {
  db.prepare("INSERT INTO automation_versions (id, automationId, version, snapshot, note, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(cryptoRandom(), automationId, version, JSON.stringify(snapshot), note || null, now());
}

export function createAutomation(userId, { name, description, triggerType, triggerConfig, variables, agentId, orgId, workspaceId, steps, status }) {
  if (orgId && !hasPermission(orgId, userId, "automation")) {
    throw new Error("You don't have automation-sharing permission in that organization.");
  }
  if (orgId) enforceQuota(orgId, "maxAutomations", "automations");
  const id = cryptoRandom();
  const resolvedTriggerConfig = { ...(triggerConfig || {}) };
  if (triggerType === "webhook" && !resolvedTriggerConfig.secret) {
    resolvedTriggerConfig.secret = cryptoRandom() + cryptoRandom(); // longer than the usual id-length secrets elsewhere
  }
  const nextRunAt = triggerType === "schedule" ? computeNextRun(resolvedTriggerConfig) : null;
  db.prepare(
    `INSERT INTO automations (id, userId, name, description, status, triggerType, triggerConfig, variables, agentId, orgId, workspaceId, version, createdAt, updatedAt, nextRunAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(id, userId, name, description || "", status || "draft", triggerType, JSON.stringify(resolvedTriggerConfig), JSON.stringify(variables || {}), agentId || null, orgId || null, workspaceId || null, now(), now(), nextRunAt);
  replaceSteps(id, steps);
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  recordVersion(id, 1, snapshotOf(automation, steps), "Created");
  return id;
}

export function updateAutomation(userId, id, fields) {
  const existing = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  if (!existing || !canManageAutomation(userId, existing)) return false;
  if (fields.orgId !== undefined && fields.orgId && !hasPermission(fields.orgId, userId, "automation")) {
    throw new Error("You don't have automation-sharing permission in that organization.");
  }

  const next = {
    name: fields.name ?? existing.name,
    description: fields.description ?? existing.description,
    status: fields.status ?? existing.status,
    triggerType: fields.triggerType ?? existing.triggerType,
    triggerConfig: fields.triggerConfig !== undefined ? JSON.stringify(fields.triggerConfig) : existing.triggerConfig,
    variables: fields.variables !== undefined ? JSON.stringify(fields.variables) : existing.variables,
    agentId: fields.agentId ?? existing.agentId,
    orgId: fields.orgId === "" ? null : (fields.orgId ?? existing.orgId),
    workspaceId: fields.workspaceId === "" ? null : (fields.workspaceId ?? existing.workspaceId),
  };
  if (next.triggerType === "webhook") {
    const parsedConfig = JSON.parse(next.triggerConfig || "{}");
    if (!parsedConfig.secret) {
      parsedConfig.secret = cryptoRandom() + cryptoRandom();
      next.triggerConfig = JSON.stringify(parsedConfig);
    }
  }
  const nextRunAt = next.triggerType === "schedule" ? computeNextRun(JSON.parse(next.triggerConfig || "{}")) : null;
  const newVersion = existing.version + 1;

  db.prepare(
    `UPDATE automations SET name=?, description=?, status=?, triggerType=?, triggerConfig=?, variables=?, agentId=?, orgId=?, workspaceId=?, version=?, updatedAt=?, nextRunAt=? WHERE id=?`
  ).run(next.name, next.description, next.status, next.triggerType, next.triggerConfig, next.variables, next.agentId, next.orgId, next.workspaceId, newVersion, now(), nextRunAt, id);

  if (fields.steps) replaceSteps(id, fields.steps);
  const updated = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  const steps = db.prepare("SELECT * FROM automation_steps WHERE automationId = ? ORDER BY stepOrder ASC").all(id).map((s) => ({ ...s, config: JSON.parse(s.config || "{}") }));
  recordVersion(id, newVersion, snapshotOf(updated, steps), fields.versionNote || "Updated");
  return true;
}

export function getAutomationVersions(userId, id) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  if (!automation || !canManageAutomation(userId, automation)) return null;
  return db.prepare("SELECT id, version, note, snapshot, createdAt FROM automation_versions WHERE automationId = ? ORDER BY version DESC").all(id)
    .map((v) => ({ ...v, snapshot: JSON.parse(v.snapshot) }));
}

export function setAutomationStatus(userId, id, status) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  if (!automation || !canManageAutomation(userId, automation)) return false;
  const r = db.prepare("UPDATE automations SET status = ?, updatedAt = ? WHERE id = ?").run(status, now(), id);
  return r.changes > 0;
}

export function deleteAutomation(userId, id) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  if (!automation || !canManageAutomation(userId, automation)) return false;
  const r = db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  return r.changes > 0;
}

// Runs/logs/dashboard metrics remain scoped to the CALLING user's own
// executions — an org member with access to a shared automation's
// definition doesn't automatically see every other member's run history
// through it; that's a reasonable default privacy boundary for now.
export function listRuns(userId, automationId, limit = 20) {
  return db.prepare(
    "SELECT * FROM automation_runs WHERE userId = ? AND automationId = ? ORDER BY createdAt DESC LIMIT ?"
  ).all(userId, automationId, limit);
}

export function getRunDetail(userId, runId) {
  const run = db.prepare("SELECT * FROM automation_runs WHERE id = ? AND userId = ?").get(runId, userId);
  if (!run) return null;
  const logs = db.prepare("SELECT * FROM automation_logs WHERE runId = ? ORDER BY createdAt ASC").all(runId);
  return { ...run, variables: JSON.parse(run.variables || "{}"), logs: logs.map((l) => ({ ...l, detail: JSON.parse(l.detail || "null") })) };
}

export function dashboardMetrics(userId) {
  const active = db.prepare("SELECT COUNT(*) c FROM automations WHERE userId = ? AND status = 'active'").get(userId).c;
  const paused = db.prepare("SELECT COUNT(*) c FROM automations WHERE userId = ? AND status = 'paused'").get(userId).c;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayRuns = db.prepare("SELECT COUNT(*) c FROM automation_runs WHERE userId = ? AND createdAt >= ?").get(userId, todayStart.toISOString()).c;
  const failedToday = db.prepare("SELECT COUNT(*) c FROM automation_runs WHERE userId = ? AND status = 'failed' AND createdAt >= ?").get(userId, todayStart.toISOString()).c;
  const completed = db.prepare(
    "SELECT startedAt, endedAt FROM automation_runs WHERE userId = ? AND status = 'completed' AND startedAt IS NOT NULL AND endedAt IS NOT NULL ORDER BY createdAt DESC LIMIT 50"
  ).all(userId);
  const durations = completed.map((r) => new Date(r.endedAt) - new Date(r.startedAt)).filter((d) => d >= 0);
  const avgRuntimeMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const totalRuns = db.prepare("SELECT COUNT(*) c FROM automation_runs WHERE userId = ?").get(userId).c;
  const successRuns = db.prepare("SELECT COUNT(*) c FROM automation_runs WHERE userId = ? AND status = 'completed'").get(userId).c;
  const upcoming = db.prepare(
    "SELECT id, name, nextRunAt FROM automations WHERE userId = ? AND status = 'active' AND nextRunAt IS NOT NULL ORDER BY nextRunAt ASC LIMIT 5"
  ).all(userId);
  const runningNow = db.prepare("SELECT COUNT(*) c FROM automation_runs WHERE userId = ? AND status IN ('running', 'awaiting_approval')").get(userId).c;

  return {
    activeWorkflows: active,
    pausedWorkflows: paused,
    todaysExecutions: todayRuns,
    failedExecutions: failedToday,
    successRate: totalRuns ? Math.round((successRuns / totalRuns) * 100) : null,
    avgRuntimeMs,
    upcomingSchedules: upcoming,
    runningWorkflows: runningNow,
  };
}
