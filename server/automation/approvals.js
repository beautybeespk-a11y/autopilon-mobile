import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createConfirmationRequest } from "../orchestrator/executor.js";

// A workflow "approval" step isn't tied to any specific tool call — it's
// just "pause here and ask the user." To avoid a parallel approval system,
// this creates a synthetic tool_executions row (toolName: 'workflow_approval',
// which is intentionally not registered in the Tool Registry) and a real
// confirmation_requests row pointing at it. The existing approve/reject
// route and UI handle it exactly like any other confirmation; executor.js's
// resumeAfterConfirmation() already knows to treat an unregistered tool as
// "nothing to execute, just resolve yes/no."
export function createApprovalStep({ runId, userId, reason }) {
  const executionId = cryptoRandom();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tool_executions (id, userId, toolName, parameters, status, createdAt)
     VALUES (?, ?, 'workflow_approval', ?, 'awaiting_confirmation', ?)`
  ).run(executionId, userId, JSON.stringify({ reason }), now);

  const confirmationId = createConfirmationRequest({
    executionId, userId, toolName: "workflow_approval", reason, automationRunId: runId,
  });

  return { executionId, confirmationId };
}
