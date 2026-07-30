import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { computeNextRun } from "./scheduler.js";

const now = () => new Date().toISOString();

export function listAutomations(userId) {
  return db.prepare("SELECT * FROM automations WHERE userId = ? ORDER BY createdAt DESC").all(userId);
}

export function getAutomation(userId, id) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ? AND userId = ?").get(id, userId);
  if (!automation) return null;
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

export function createAutomation(userId, { name, description, triggerType, triggerConfig, variables, agentId, steps, status }) {
  const id = cryptoRandom();
  const resolvedTriggerConfig = { ...(triggerConfig || {}) };
  if (triggerType === "webhook" && !resolvedTriggerConfig.secret) {
    resolvedTriggerConfig.secret = cryptoRandom() + cryptoRandom(); // longer than the usual id-length secrets elsewhere
  }
  const nextRunAt = triggerType === "schedule" ? computeNextRun(resolvedTriggerConfig) : null;
  db.prepare(
    `INSERT INTO automations (id, userId, name, description, status, triggerType, triggerConfig, variables, agentId, createdAt, updatedAt, nextRunAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, name, description || "", status || "draft", triggerType, JSON.stringify(resolvedTriggerConfig), JSON.stringify(variables || {}), agentId || null, now(), now(), nextRunAt);
  replaceSteps(id, steps);
  return id;
}

export function updateAutomation(userId, id, fields) {
  const existing = db.prepare("SELECT * FROM automations WHERE id = ? AND userId = ?").get(id, userId);
  if (!existing) return false;

  const next = {
    name: fields.name ?? existing.name,
    description: fields.description ?? existing.description,
    status: fields.status ?? existing.status,
    triggerType: fields.triggerType ?? existing.triggerType,
    triggerConfig: fields.triggerConfig !== undefined ? JSON.stringify(fields.triggerConfig) : existing.triggerConfig,
    variables: fields.variables !== undefined ? JSON.stringify(fields.variables) : existing.variables,
    agentId: fields.agentId ?? existing.agentId,
  };
  if (next.triggerType === "webhook") {
    const parsedConfig = JSON.parse(next.triggerConfig || "{}");
    if (!parsedConfig.secret) {
      parsedConfig.secret = cryptoRandom() + cryptoRandom();
      next.triggerConfig = JSON.stringify(parsedConfig);
    }
  }
  const nextRunAt = next.triggerType === "schedule" ? computeNextRun(JSON.parse(next.triggerConfig || "{}")) : null;

  db.prepare(
    `UPDATE automations SET name=?, description=?, status=?, triggerType=?, triggerConfig=?, variables=?, agentId=?, updatedAt=?, nextRunAt=? WHERE id=?`
  ).run(next.name, next.description, next.status, next.triggerType, next.triggerConfig, next.variables, next.agentId, now(), nextRunAt, id);

  if (fields.steps) replaceSteps(id, fields.steps);
  return true;
}

export function setAutomationStatus(userId, id, status) {
  const r = db.prepare("UPDATE automations SET status = ?, updatedAt = ? WHERE id = ? AND userId = ?").run(status, now(), id, userId);
  return r.changes > 0;
}

export function deleteAutomation(userId, id) {
  const r = db.prepare("DELETE FROM automations WHERE id = ? AND userId = ?").run(id, userId);
  return r.changes > 0;
}

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
