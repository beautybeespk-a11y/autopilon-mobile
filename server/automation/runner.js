import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { executeStep } from "./stepExecutor.js";
import { createNotification } from "../orchestrator/notifications.js";
import { recordUsage } from "../orchestrator/billing.js";

const now = () => new Date().toISOString();

function loadSteps(automationId) {
  return db.prepare("SELECT * FROM automation_steps WHERE automationId = ? ORDER BY stepOrder ASC").all(automationId);
}

function log(runId, stepOrder, stepType, status, detail) {
  db.prepare(
    "INSERT INTO automation_logs (id, runId, stepOrder, stepType, status, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(cryptoRandom(), runId, stepOrder, stepType, status, JSON.stringify(detail ?? null), now());
}

function updateRun(runId, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE automation_runs SET ${sets} WHERE id = ?`).run(...Object.values(fields), runId);
}

export function createRun({ automationId, userId, triggerSource, initialVariables }) {
  const runId = cryptoRandom();
  db.prepare(
    `INSERT INTO automation_runs (id, automationId, userId, status, triggerSource, variables, currentStep, createdAt)
     VALUES (?, ?, ?, 'pending', ?, ?, 0, ?)`
  ).run(runId, automationId, userId, triggerSource, JSON.stringify(initialVariables || {}), now());
  return runId;
}

// Executes an automation from scratch. Never throws — failures are recorded
// on the run itself, since this is called from fire-and-forget contexts
// (the scheduler, a trigger) as often as from a request handler.
export async function runWorkflow(automationId, { userId, triggerSource, initialVariables }) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(automationId);
  if (!automation) return { status: "failed", error: "Automation not found" };
  // Access to a shared automation is validated by the caller (canAccessAutomation
  // in engine.js), not re-checked here. Unlike Shared Agents (which execute
  // under whoever is chatting), an automation's tool calls always run as its
  // configured OWNER (automation.userId, set in driveRun's ctx below) — most
  // runs have no "current person" to act as at all (schedules, webhooks), so
  // this stays consistent regardless of who — if anyone — triggered a given
  // run. `userId` here just records who triggered THIS run for their own history.

  const defaultVars = JSON.parse(automation.variables || "{}");
  const runId = createRun({ automationId, userId, triggerSource, initialVariables: { ...defaultVars, ...(initialVariables || {}) } });

  db.prepare("UPDATE automations SET lastRunAt = ? WHERE id = ?").run(now(), automationId);
  if (automation.orgId) recordUsage(automation.orgId, "automation_execution");
  updateRun(runId, { status: "running", startedAt: now() });

  const result = await driveRun(runId, automation, 0, JSON.parse(db.prepare("SELECT variables FROM automation_runs WHERE id = ?").get(runId).variables));

  if (result.status === "failed") {
    createNotification(automation.userId, {
      type: "automation_failure",
      title: `"${automation.name}" failed`,
      body: result.error || "The workflow stopped due to an error.",
      link: "/app/automations",
    });
  }

  // Only fire automation_completed/failed for "top-level" runs (started
  // manually or by the scheduler) — never for a run whose own trigger was
  // itself an event. Without this guard, a workflow that reacts to
  // "automation completed" could trigger a run whose own completion fires
  // the same event again, chaining indefinitely.
  if (triggerSource === "manual" || triggerSource === "schedule") {
    const { publishEvent } = await import("./triggers.js");
    if (result.status === "completed") {
      publishEvent(userId, "internal", "automation_completed", { automationId, automationName: automation.name, runId });
    } else if (result.status === "failed") {
      publishEvent(userId, "internal", "automation_failed", { automationId, automationName: automation.name, runId, error: result.error });
    }
  }

  return result;
}

// The actual step loop, shared between a fresh run and a resumed one.
async function driveRun(runId, automation, fromStepOrder, variables) {
  const steps = loadSteps(automation.id);
  const ctx = { runId, userId: automation.userId, agentId: automation.agentId, orgId: automation.orgId };
  let currentVars = variables;

  for (const step of steps) {
    if (step.stepOrder < fromStepOrder) continue;

    log(runId, step.stepOrder, step.type, "started");
    updateRun(runId, { currentStep: step.stepOrder, variables: JSON.stringify(currentVars) });

    let result;
    try {
      result = await executeStep(step, currentVars, ctx);
    } catch (err) {
      log(runId, step.stepOrder, step.type, "failed", { error: err.message });
      updateRun(runId, { status: "failed", error: err.message, endedAt: now(), variables: JSON.stringify(currentVars) });
      return { status: "failed", error: err.message };
    }

    currentVars = result.variables;

    if (result.outcome === "fail") {
      log(runId, step.stepOrder, step.type, "failed", { error: result.error });
      updateRun(runId, { status: "failed", error: result.error, endedAt: now(), variables: JSON.stringify(currentVars) });
      return { status: "failed", error: result.error };
    }

    if (result.outcome === "pause") {
      log(runId, step.stepOrder, step.type, "started", { awaitingConfirmation: result.confirmationId, reason: result.reason });
      updateRun(runId, { status: "awaiting_approval", variables: JSON.stringify(currentVars) });
      return { status: "awaiting_approval", confirmationId: result.confirmationId };
    }

    if (result.outcome === "end") {
      log(runId, step.stepOrder, step.type, "completed", { endedEarly: true });
      updateRun(runId, { status: "completed", endedAt: now(), variables: JSON.stringify(currentVars) });
      return { status: "completed" };
    }

    if (result.outcome === "jump") {
      log(runId, step.stepOrder, step.type, "completed", { jumpedTo: result.jumpTo });
      return driveRun(runId, automation, result.jumpTo, currentVars);
    }

    log(runId, step.stepOrder, step.type, "completed", result.warning ? { warning: result.warning } : undefined);
  }

  updateRun(runId, { status: "completed", endedAt: now(), variables: JSON.stringify(currentVars) });
  return { status: "completed" };
}

export async function runScheduledAutomation(automationId) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(automationId);
  if (!automation) return { status: "failed", error: "Automation not found" };
  return runWorkflow(automationId, { userId: automation.userId, triggerSource: "schedule", initialVariables: {} });
}
// Called from the confirmations route when a workflow's approval step (or a
// confirmation-gated action step) gets resolved — continues the run from
// the next step rather than leaving it stuck at "awaiting_approval" forever.
export async function resumeRunAfterApproval(runId, approved) {
  const run = db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(runId);
  if (!run) return;
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(run.automationId);
  if (!automation) return;

  if (!approved) {
    updateRun(runId, { status: "cancelled", endedAt: now() });
    log(runId, run.currentStep, "approval", "failed", { rejected: true });
    return;
  }

  const variables = JSON.parse(run.variables || "{}");
  await driveRun(runId, automation, run.currentStep + 1, variables);
}
