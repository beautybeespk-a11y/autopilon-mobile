import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getTool, validateParameters, toolRequiresConfirmation } from "../tools/registry.js";
import { toolAvailableToAgent } from "./permissions.js";
import { createNotification } from "./notifications.js";

const now = () => new Date().toISOString();

function createExecutionRow({ planId, userId, agentId, conversationId, toolName, parameters }) {
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO tool_executions (id, planId, userId, agentId, conversationId, toolName, parameters, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, planId || null, userId, agentId || null, conversationId || null, toolName, JSON.stringify(parameters || {}), now());
  return id;
}

function setExecutionStatus(id, status, extra = {}) {
  const fields = ["status = ?"];
  const args = [status];
  if (extra.result !== undefined) { fields.push("result = ?"); args.push(JSON.stringify(extra.result)); }
  if (extra.error !== undefined) { fields.push("error = ?"); args.push(extra.error); }
  if (extra.startedAt) { fields.push("startedAt = ?"); args.push(extra.startedAt); }
  if (extra.completedAt) { fields.push("completedAt = ?"); args.push(extra.completedAt); }
  args.push(id);
  db.prepare(`UPDATE tool_executions SET ${fields.join(", ")} WHERE id = ?`).run(...args);
}

export function getExecution(id) {
  return db.prepare("SELECT * FROM tool_executions WHERE id = ?").get(id);
}

export function createConfirmationRequest({ executionId, userId, toolName, reason, automationRunId }) {
  const id = cryptoRandom();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 15).toISOString(); // 15 min
  db.prepare(
    `INSERT INTO confirmation_requests (id, executionId, userId, toolName, reason, status, createdAt, expiresAt, automationRunId)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(id, executionId, userId, toolName, reason, createdAt, expiresAt, automationRunId || null);
  createNotification(userId, {
    type: "approval",
    title: "Action needs your approval",
    body: reason || `"${toolName}" is waiting for your confirmation.`,
    link: automationRunId ? "/app/automations" : "/app/chat",
  });
  return id;
}

/**
 * Runs a single tool call through its full lifecycle:
 * planning -> (awaiting_confirmation) -> running -> completed|failed
 * Confirmation-gated tools stop at "awaiting_confirmation" and return
 * without executing; execution resumes later via resumeAfterConfirmation().
 */
export async function runTool({ toolName, parameters, userId, agentId, conversationId, planId, automationRunId }) {
  const executionId = createExecutionRow({ planId, userId, agentId, conversationId, toolName, parameters });
  setExecutionStatus(executionId, "planning");

  const tool = getTool(toolName, userId);
  if (!tool) {
    setExecutionStatus(executionId, "failed", { error: `Unknown tool "${toolName}"`, completedAt: now() });
    return { executionId, status: "failed", error: `Unknown tool "${toolName}"` };
  }

  const availability = toolAvailableToAgent(toolName, agentId, userId);
  if (!availability.available) {
    setExecutionStatus(executionId, "failed", { error: availability.reason, completedAt: now() });
    return { executionId, status: "failed", error: availability.reason };
  }

  const validation = validateParameters(toolName, parameters, userId);
  if (!validation.valid) {
    setExecutionStatus(executionId, "failed", { error: validation.error, completedAt: now() });
    return { executionId, status: "failed", error: validation.error };
  }

  if (toolRequiresConfirmation(toolName, userId)) {
    setExecutionStatus(executionId, "awaiting_confirmation");
    const reason = confirmationReason(toolName, parameters);
    const confirmationId = createConfirmationRequest({ executionId, userId, toolName, reason, automationRunId });
    return { executionId, status: "awaiting_confirmation", confirmationId, reason };
  }

  return executeNow({ executionId, tool, parameters, userId, agentId });
}

async function executeNow({ executionId, tool, parameters, userId, agentId }) {
  setExecutionStatus(executionId, "running", { startedAt: now() });
  try {
    const result = await tool.execute(parameters, { userId, agentId });
    setExecutionStatus(executionId, "completed", { result, completedAt: now() });
    return { executionId, status: "completed", result };
  } catch (err) {
    setExecutionStatus(executionId, "failed", { error: err.message, completedAt: now() });
    return { executionId, status: "failed", error: err.message };
  }
}

// Called once a pending confirmation is resolved (approve/reject).
export async function resumeAfterConfirmation({ executionId, approved }) {
  const execution = getExecution(executionId);
  if (!execution) throw new Error("Execution not found");
  if (execution.status !== "awaiting_confirmation") {
    throw new Error(`Execution is not awaiting confirmation (status: ${execution.status})`);
  }
  if (!approved) {
    setExecutionStatus(executionId, "failed", { error: "Rejected by user", completedAt: now() });
    return { executionId, status: "failed", error: "Rejected by user" };
  }
  const tool = getTool(execution.toolName, execution.userId);
  const parameters = JSON.parse(execution.parameters || "{}");
  if (!tool) {
    // Not a real registered tool — this is a pure workflow approval gate
    // (see automation/approvals.js) with nothing to execute, just a
    // yes/no the workflow runner is waiting on.
    setExecutionStatus(executionId, "completed", { result: { approved: true }, completedAt: now() });
    return { executionId, status: "completed", result: { approved: true } };
  }
  return executeNow({ executionId, tool, parameters, userId: execution.userId, agentId: execution.agentId });
}

function confirmationReason(toolName, parameters) {
  if (toolName === "create_memory") {
    return `This permanently stores in your long-term memory: "${parameters.content}"`;
  }
  if (toolName === "delete_memory") {
    return "This permanently deletes a memory. This cannot be undone.";
  }
  if (toolName === "save_research") {
    return `This saves "${parameters.title}" to your Knowledge Library.`;
  }
  if (toolName === "delete_saved_research") {
    return "This permanently deletes a saved research item. This cannot be undone.";
  }
  if (toolName === "create_campaign") {
    return `This creates a new Meta campaign — Name: "${parameters.name}", Objective: ${parameters.objective}${parameters.dailyBudget ? `, Daily budget: ${parameters.dailyBudget}` : ""}. It will be created paused, but this is a real campaign on your ad account.`;
  }
  if (toolName === "update_campaign") {
    return `This updates campaign ${parameters.campaignId} on your live Meta ad account.`;
  }
  if (toolName === "pause_campaign") {
    return `This pauses campaign ${parameters.campaignId}, stopping its spend.`;
  }
  if (toolName === "resume_campaign") {
    return `This resumes campaign ${parameters.campaignId}, allowing it to spend budget again.`;
  }
  if (toolName === "delete_file") {
    return "This moves a file to Trash. It can be restored from there until it's permanently deleted.";
  }
  if (toolName === "share_file") {
    return "This creates a link that lets anyone who has it access this file, outside the platform's normal permissions.";
  }
  return "This action requires your approval before it runs.";
}
