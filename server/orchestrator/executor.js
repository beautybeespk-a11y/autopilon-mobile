import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getTool, validateParameters, toolRequiresConfirmation } from "../tools/registry.js";
import { toolAvailableToAgent } from "./permissions.js";
import { createNotification } from "./notifications.js";
import { getStoredPlan, getActivePlanForConversation } from "../agents/metaExpert/planner.js";
import { getStoredStrategy, getActiveStrategyForConversation, recordStrategyApproval } from "../agents/metaExpertV2/strategyStore.js";
import { fingerprintStrategy } from "../agents/metaExpertV2/policy.js";
import { isV2RuntimeEnabled } from "../agents/metaExpertV2/runtimeGate.js";

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
  // Stream B: one live confirmation per (user, tool, conversation) intent.
  // Before inserting a new card, expire any still-pending card for the same
  // tool in the same conversation (looked up through tool_executions, since
  // confirmation_requests has no conversationId of its own). Without this,
  // every re-call of execute_strategy stacked another pending card — the
  // exact pile-up the typed-"approve" loop produced — and an old card could
  // later be clicked to approve a strategy that has since been superseded.
  // Automation-run approvals (automationRunId set) are excluded: they are
  // not chat-conversation intents and must never be expired by a chat call.
  if (!automationRunId) {
    const execution = db.prepare("SELECT conversationId FROM tool_executions WHERE id = ?").get(executionId);
    if (execution?.conversationId) {
      db.prepare(
        `UPDATE confirmation_requests SET status = 'expired', resolvedAt = ?
         WHERE userId = ? AND toolName = ? AND status = 'pending' AND automationRunId IS NULL
           AND executionId IN (SELECT id FROM tool_executions WHERE conversationId = ?)`
      ).run(now(), userId, toolName, execution.conversationId);
    }
  }
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
export async function runTool({ toolName, parameters, userId, agentId, conversationId, planId, automationRunId, userMessage }) {
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
    const reason = confirmationReason(toolName, parameters, { userId, conversationId });
    const confirmationId = createConfirmationRequest({ executionId, userId, toolName, reason, automationRunId });
    return { executionId, status: "awaiting_confirmation", confirmationId, reason };
  }

  return executeNow({ executionId, tool, parameters, userId, agentId, conversationId, userMessage });
}

async function executeNow({ executionId, tool, parameters, userId, agentId, conversationId, userMessage }) {
  setExecutionStatus(executionId, "running", { startedAt: now() });
  try {
    const result = await tool.execute(parameters, { userId, agentId, conversationId, userMessage });
    setExecutionStatus(executionId, "completed", { result, completedAt: now() });
    return { executionId, status: "completed", result };
  } catch (err) {
    setExecutionStatus(executionId, "failed", { error: err.message, completedAt: now() });
    // err.code/err.subcode are set by integrations/meta/api.js's metaFetch
    // from Meta's own error payload (e.g. code 100, subcode 3858558 for a
    // too-low budget) — previously dropped here, leaving only the message
    // string for callers. Additive: undefined for any error that doesn't
    // set them, which every existing caller already tolerates since they
    // only ever read .error.
    return { executionId, status: "failed", error: err.message, code: err.code, subcode: err.subcode };
  }
}

// A small number of tools need to react to their OWN confirmation being
// declined — e.g. the Meta Expert planner (server/agents/metaExpert/)
// marking its proposed plan 'rejected' rather than leaving it dangling in
// 'proposed' state forever. Same precedent as confirmationReason() below
// (per-tool special cases already live in this file); kept to a plain
// name->callback map rather than a new plugin system for one real case.
const onRejectedHandlers = {};
export function registerOnRejectedHandler(toolName, handler) {
  onRejectedHandlers[toolName] = handler;
}

// Called once a pending confirmation is resolved (approve/reject).
export async function resumeAfterConfirmation({ executionId, approved }) {
  const execution = getExecution(executionId);
  if (!execution) throw new Error("Execution not found");
  if (execution.status !== "awaiting_confirmation") {
    throw new Error(`Execution is not awaiting confirmation (status: ${execution.status})`);
  }
  // Stream B (test stage): the card-click path (routes/confirmations.js
  // resolve()) marks the confirmation row approved/rejected BEFORE calling
  // this function, but the typed-approve/decline path (orchestrator's
  // interception) calls this function directly — without the row update, a
  // typed approval left the row 'pending' forever: the created campaign
  // kept showing as awaiting approval in GET /pending, and a later click
  // on the stale card would 500 here (execution no longer awaiting
  // confirmation). Mark it here, the single place both paths flow
  // through; the route's own UPDATE is idempotent with this one (same
  // status, same row), so marking twice is harmless. Marked before the
  // dispatch below on purpose: the user DID approve (or decline) — if
  // execution then fails for another reason (e.g. a Meta error), the
  // approval itself still happened, exactly as the route already does.
  db.prepare("UPDATE confirmation_requests SET status = ?, resolvedAt = ? WHERE executionId = ? AND status = 'pending'")
    .run(approved ? "approved" : "rejected", now(), executionId);
  if (!approved) {
    setExecutionStatus(executionId, "failed", { error: "Rejected by user", completedAt: now() });
    const onRejected = onRejectedHandlers[execution.toolName];
    if (onRejected) {
      try {
        await onRejected(JSON.parse(execution.parameters || "{}"), { userId: execution.userId, conversationId: execution.conversationId });
      } catch {
        // Best-effort — a failure here must never mask the real rejection outcome above.
      }
    }
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
  // Stream B: the card click (or typed-approve resume, Patch 5a) IS the
  // approval event — record it, bound to the strategy's CURRENT fingerprint,
  // BEFORE re-dispatching. executeStrategy() re-runs with userMessage ===
  // undefined on this path (executeNow passes no userMessage), so without
  // this persisted approval its own check (Patch 1) would reject every
  // card click with META_V2_APPROVAL_REQUIRED. This is the single place
  // card/typed approval is persisted — routes/confirmations.js must NOT
  // duplicate it (it calls this function; see its resolve()).
  // Test-stage fix (kill switch, round 2): the runtime gate must be
  // checked BEFORE the approval is recorded, not just inside
  // executeStrategy() afterwards — recording first silently marks the
  // strategy "approved" even though execution is blocked while V2 is
  // disabled, so the row no longer reflects that nothing was approved
  // while the feature was off. When disabled, skip recording entirely
  // (the strategy stays "proposed"); executeNow below still fails at
  // executeStrategy's own gate with META_EXPERT_V2_DISABLED.
  if (approved && execution.toolName === "meta_expert_v2.execute_strategy" && isV2RuntimeEnabled(execution.userId)) {
    try {
      const target = parameters.strategyId
        ? getStoredStrategy(execution.userId, parameters.strategyId)
        : getActiveStrategyForConversation(execution.userId, execution.conversationId);
      if (target && ["proposed", "approved"].includes(target.status)) {
        recordStrategyApproval(target.id, fingerprintStrategy(target.strategy), "confirmation-card");
      }
      // If there is no executable target (already executed / superseded),
      // record nothing: executeStrategy()'s own loadExecutable() will fail
      // honestly below, and the orchestrator's already-executed
      // short-circuit handles the normal double-approve case before this
      // function is ever reached.
    } catch (recordErr) {
      // Recording approval must never mask the real outcome: if the import
      // or lookup fails, executeStrategy() will still run and fail with
      // META_V2_APPROVAL_REQUIRED, which is diagnosable — rather than
      // pretending the click worked. Log loudly.
      console.error("[resumeAfterConfirmation] failed to record V2 approval:", recordErr.message);
    }
  }
  return executeNow({ executionId, tool, parameters, userId: execution.userId, agentId: execution.agentId, conversationId: execution.conversationId });
}

function confirmationReason(toolName, parameters, context = {}) {
  if (toolName === "meta_expert.execute_campaign_plan") {
    // Live testing round 3: the generic fallback message below ("This
    // action requires your approval before it runs") told the user nothing
    // about WHAT they were approving — clicking through it, they'd only
    // find out something was wrong when Meta itself rejected the campaign
    // afterward. Show the real plan (objective, budget, Page) so an
    // obviously-wrong or stale plan is visible before the click, not after.
    const stored = parameters.planId
      ? getStoredPlan(context.userId, parameters.planId)
      : getActivePlanForConversation(context.userId, context.conversationId);
    if (!stored) return "This creates a real (paused) Meta Campaign and Ad Set — but no valid plan was found to execute. Approving this will fail.";
    const { plan } = stored.planData;
    const budget = plan.daily_budget != null ? `${plan.daily_budget}/day` : "no budget set yet";
    return `This creates a real Meta Campaign + Ad Set (PAUSED) for: "${plan.goal}" — Objective: ${plan.objective}, Budget: ${budget}. Nothing spends until you separately resume it in Meta.`;
  }
  if (toolName === "meta_expert_v2.execute_strategy") {
    // Stream B: same reasoning as the V1 execute_campaign_plan branch
    // above — a generic "requires your approval" card tells the user
    // nothing about WHAT they are approving, which is how a stale card
    // gets clicked for the wrong strategy. (Option 1: static import at the
    // top of this file — strategyStore imports only db/middleware/
    // diagnostics/policy, so there is no cycle.)
    try {
      const stored = parameters.strategyId
        ? getStoredStrategy(context.userId, parameters.strategyId)
        : getActiveStrategyForConversation(context.userId, context.conversationId);
      if (!stored) return "This creates a real (paused) Meta Campaign and Ad Set — but no valid strategy was found to execute. Approving this will fail.";
      const s = stored.strategy;
      const budget = s.budget_daily != null ? `${s.budget_daily}/day` : "no budget set yet";
      const page = stored.resolvedAssets?.pageName || stored.resolvedAssets?.pageId || "unknown Page";
      return `This creates a real Meta Campaign + Ad Set (PAUSED) for: "${s.business_goal || "your campaign"}" — Objective: ${s.recommended_objective}, Budget: ${budget}, Page: ${page}. Nothing spends until you separately resume it in Meta.`;
    } catch {
      return "This creates a real (paused) Meta Campaign and Ad Set. Approving this will create it — nothing spends until you separately resume it in Meta.";
    }
  }
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
