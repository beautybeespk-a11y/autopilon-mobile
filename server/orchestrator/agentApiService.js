// Public Agent API business logic (Phase 17 §5/§6/§7). Every execution
// path here reuses handleIncomingMessage()/orchestrate() exactly as
// internal chat does — nothing here re-implements AI calling, tool
// execution, quota enforcement, or usage recording; api_agent_runs is only
// a tracking record layered on top.
//
// Tenant boundary: every query in this file is filtered by orgId, taken
// directly from the API key (never derived from a user's broader
// membership list the way listAccessibleAgents() does for the internal
// app) — an API key for org A must never be able to see or execute org B's
// agent even if the key's own creator happens to also belong to org B.
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { handleIncomingMessage } from "./conversationService.js";
import { createJob, getJob } from "../jobs/jobManager.js";
import { publishDeveloperWebhookEvent } from "./webhookEvents.js";

const now = () => new Date().toISOString();

export function listOrgAgents(orgId, { limit, cursorClause }) {
  const rows = db.prepare(
    `SELECT * FROM agents WHERE orgId = ? ${cursorClause.sql} ORDER BY createdAt DESC, id DESC LIMIT ?`
  ).all(orgId, ...cursorClause.params, limit + 1);
  return rows;
}

export function getOrgAgent(orgId, agentId) {
  return db.prepare("SELECT * FROM agents WHERE id = ? AND orgId = ?").get(agentId, orgId);
}

function recordRun({ orgId, apiKeyId, agentId, userId, conversationId, mode, inputMessage }) {
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO api_agent_runs (id, orgId, apiKeyId, agentId, userId, conversationId, mode, status, inputMessage, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
  ).run(id, orgId, apiKeyId, agentId, userId, conversationId || null, mode, inputMessage || null, now());
  return id;
}

function markRunRunning(runId) {
  db.prepare("UPDATE api_agent_runs SET status = 'running' WHERE id = ?").run(runId);
}

function markRunCompleted(runId, { conversationId, resultText, promptTokens, completionTokens }) {
  db.prepare(
    `UPDATE api_agent_runs SET status = 'completed', conversationId = ?, resultText = ?, promptTokens = ?, completionTokens = ?, completedAt = ? WHERE id = ?`
  ).run(conversationId, resultText, promptTokens || 0, completionTokens || 0, now(), runId);
}

function markRunFailed(runId, errorMessage) {
  db.prepare("UPDATE api_agent_runs SET status = 'failed', errorMessage = ?, completedAt = ? WHERE id = ?").run(errorMessage, now(), runId);
}

// The one real execution path — both the synchronous route handler and the
// async job handler call this, so there is exactly one place that actually
// talks to the orchestrator. orgId is only needed for the webhook events
// this fires (agent.run.started/completed/failed, Phase 17 §17) — the
// execution itself resolves its own billing org from the agent, same as
// internal chat.
async function runAgentTurn({ runId, orgId, userId, agentId, conversationId, message }) {
  markRunRunning(runId);
  publishDeveloperWebhookEvent(orgId, "agent.run.started", { runId, agentId, conversationId: conversationId || null });
  try {
    let convId = conversationId;
    if (!convId) {
      convId = cryptoRandom();
      db.prepare("INSERT INTO conversations (id, userId, agentId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run(convId, userId, agentId, `API run ${runId.slice(0, 8)}`, now(), now());
    }
    const { reply, usage } = await handleIncomingMessage({ userId, agentId, conversationId: convId, content: message });
    // usage is the per-turn total orchestrate() now returns (added as part
    // of this task) — the exact same numbers costEngine.js's
    // recordAiTextUsage() already wrote into usage_records for billing;
    // this run row's token columns are a convenience copy for the
    // Developer Console, not a second source of truth.
    markRunCompleted(runId, { conversationId: convId, resultText: reply, ...(usage || {}) });
    publishDeveloperWebhookEvent(orgId, "agent.run.completed", { runId, agentId, conversationId: convId });
    return { conversationId: convId, reply };
  } catch (err) {
    markRunFailed(runId, err.message);
    publishDeveloperWebhookEvent(orgId, "agent.run.failed", { runId, agentId, error: err.message });
    throw err;
  }
}

// Synchronous execution — the default. Returns once the agent has actually
// replied, same latency characteristics as the internal chat endpoint.
export async function executeAgentSync({ orgId, apiKeyId, userId, agentId, message, conversationId }) {
  const runId = recordRun({ orgId, apiKeyId, agentId, userId, conversationId, mode: "sync", inputMessage: message });
  const { conversationId: convId, reply } = await runAgentTurn({ runId, orgId, userId, agentId, conversationId, message });
  const run = getRun(orgId, runId);
  return { ...run, conversationId: convId, reply };
}

// Async execution — returns immediately with a queued run; the Job Manager
// picks it up on its next tick (Phase 16, already running in the
// background) and calls the exact same runAgentTurn() the sync path uses.
export function executeAgentAsync({ orgId, apiKeyId, userId, agentId, message, conversationId }) {
  const runId = recordRun({ orgId, apiKeyId, agentId, userId, conversationId, mode: "async", inputMessage: message });
  const job = createJob({ type: "public_api.agent_run", orgId, userId, agentId, payload: { runId, orgId, userId, agentId, conversationId, message } });
  db.prepare("UPDATE api_agent_runs SET jobId = ? WHERE id = ?").run(job.id, runId);
  return getRun(orgId, runId);
}

// Called by jobs/handlers.js's registered handler for "public_api.agent_run".
export async function executeAgentRunFromJob({ runId, orgId, userId, agentId, conversationId, message }) {
  return runAgentTurn({ runId, orgId, userId, agentId, conversationId, message });
}

function toPublicRunShape(row) {
  if (!row) return null;
  return {
    id: row.id, agentId: row.agentId, conversationId: row.conversationId, jobId: row.jobId,
    mode: row.mode, status: row.status, response: row.resultText,
    usage: { promptTokens: row.promptTokens, completionTokens: row.completionTokens },
    error: row.errorMessage, createdAt: row.createdAt, completedAt: row.completedAt,
  };
}

export function getRun(orgId, runId) {
  return toPublicRunShape(db.prepare("SELECT * FROM api_agent_runs WHERE id = ? AND orgId = ?").get(runId, orgId));
}

export function listRunsForAgent(orgId, agentId, { limit, cursorClause }) {
  const rows = db.prepare(
    `SELECT * FROM api_agent_runs WHERE orgId = ? AND agentId = ? ${cursorClause.sql} ORDER BY createdAt DESC, id DESC LIMIT ?`
  ).all(orgId, agentId, ...cursorClause.params, limit + 1);
  return rows.map(toPublicRunShape);
}
