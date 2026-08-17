// Automation service for the Public API (Phase 17 §8). Every query here is
// filtered by orgId directly — NOT by delegating to automation/engine.js's
// canAccessAutomation()/getAutomation(userId, id), which check the
// CALLER'S OWN broader org membership (any org they personally belong to),
// not the specific org this API key was issued for. An API key for org A
// must never resolve an automation belonging to org B just because the
// key's creator also happens to be a member of org B — same class of gap
// already fixed for chat/agents this phase.
//
// Execution itself DOES reuse automation/runner.js's runWorkflow() as-is —
// once this file has confirmed the automation belongs to req.orgId, running
// it is exactly the same operation the internal "Run now" button performs,
// including all of its own quota/usage/notification logic.
import db from "../db.js";
import { runWorkflow } from "../automation/runner.js";

function toPublicShape(automation) {
  if (!automation) return null;
  return {
    id: automation.id, name: automation.name, description: automation.description,
    triggerType: automation.triggerType, status: automation.status,
    agentId: automation.agentId, lastRunAt: automation.lastRunAt, nextRunAt: automation.nextRunAt,
    createdAt: automation.createdAt, updatedAt: automation.updatedAt,
  };
}

export function listOrgAutomations(orgId, { limit, cursorClause }) {
  const rows = db.prepare(
    `SELECT * FROM automations WHERE orgId = ? ${cursorClause.sql} ORDER BY createdAt DESC, id DESC LIMIT ?`
  ).all(orgId, ...cursorClause.params, limit + 1);
  return rows.map(toPublicShape);
}

export function getOrgAutomation(orgId, automationId) {
  const row = db.prepare("SELECT * FROM automations WHERE id = ? AND orgId = ?").get(automationId, orgId);
  return toPublicShape(row);
}

// Returns the raw automation row (not the public shape) for internal use by
// triggerOrgAutomation — callers that need the public shape use getOrgAutomation.
function getRawOrgAutomation(orgId, automationId) {
  return db.prepare("SELECT * FROM automations WHERE id = ? AND orgId = ?").get(automationId, orgId);
}

export async function triggerOrgAutomation(orgId, automationId, { userId, variables }) {
  const automation = getRawOrgAutomation(orgId, automationId);
  if (!automation) { const err = new Error("Automation not found."); err.code = "NOT_FOUND"; throw err; }
  if (automation.status !== "active") { const err = new Error(`Automation is "${automation.status}", not active.`); err.code = "INVALID"; throw err; }
  return runWorkflow(automation.id, { userId, triggerSource: "manual", initialVariables: variables || {} });
}

export function listOrgAutomationRuns(orgId, automationId, { limit, cursorClause }) {
  const automation = getRawOrgAutomation(orgId, automationId);
  if (!automation) { const err = new Error("Automation not found."); err.code = "NOT_FOUND"; throw err; }
  return db.prepare(
    `SELECT * FROM automation_runs WHERE automationId = ? ${cursorClause.sql} ORDER BY createdAt DESC, id DESC LIMIT ?`
  ).all(automationId, ...cursorClause.params, limit + 1);
}

export function getOrgAutomationRun(orgId, runId) {
  const run = db.prepare(
    `SELECT r.* FROM automation_runs r JOIN automations a ON a.id = r.automationId WHERE r.id = ? AND a.orgId = ?`
  ).get(runId, orgId);
  if (!run) return null;
  return { ...run, variables: JSON.parse(run.variables || "{}") };
}
