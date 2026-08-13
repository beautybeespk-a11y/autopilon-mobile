// Centralized Job Manager (Phase 16 §2) — the one place that creates,
// tracks, and drives background work, sitting on top of the Queue Provider
// abstraction (queueProvider.js) so nothing here depends on the in-process
// implementation being the permanent one.
import db from "../db.js";
import { getQueueProvider } from "./queueProvider.js";

// One handler per job `type`, same registration shape as tools/registry.js
// — a new background job type means "write the handler, register it,"
// nothing here changes. A handler receives (payload, context) and either
// returns a JSON-serializable result or throws; throwing with
// `err.retryable = false` set skips the backoff/retry path entirely (spec
// §3 — never blindly retry something dangerous to repeat).
const HANDLERS = new Map();
export function registerJobHandler(type, handler) {
  HANDLERS.set(type, handler);
}

function withJson(job) {
  if (!job) return job;
  return { ...job, payload: JSON.parse(job.payload || "{}"), result: job.result ? JSON.parse(job.result) : null };
}

export function createJob({ type, orgId, workspaceId, userId, agentId, automationId, payload, priority, maxAttempts, idempotencyKey }) {
  if (!type) throw new Error("Job type is required");
  const job = getQueueProvider().enqueue({ type, orgId, workspaceId, userId, agentId, automationId, payload, priority, maxAttempts, idempotencyKey });
  return withJson(job);
}

export function getJob(id) {
  return withJson(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
}

export function listJobs({ orgId, workspaceId, userId, agentId, automationId, type, status, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (orgId) { clauses.push("orgId = ?"); params.push(orgId); }
  if (workspaceId) { clauses.push("workspaceId = ?"); params.push(workspaceId); }
  if (userId) { clauses.push("userId = ?"); params.push(userId); }
  if (agentId) { clauses.push("agentId = ?"); params.push(agentId); }
  if (automationId) { clauses.push("automationId = ?"); params.push(automationId); }
  if (type) { clauses.push("type = ?"); params.push(type); }
  if (status) { clauses.push("status = ?"); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM jobs ${where} ORDER BY createdAt DESC LIMIT ?`;
  params.push(Math.min(limit, 1000)); // hard cap — this backs an admin list, never an unbounded export
  return db.prepare(sql).all(...params).map(withJson);
}

export const cancelJob = (id) => getQueueProvider().cancel(id);
export const retryJob = (id) => getQueueProvider().retry(id);
export const pauseJob = (id) => getQueueProvider().pause(id);
export const resumeJob = (id) => getQueueProvider().resume(id);
export const reportProgress = (id, percent, note) => getQueueProvider().progress(id, percent, note);

export function jobStats(filter = {}) {
  const jobs = listJobs({ ...filter, limit: 1000 });
  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  return byStatus;
}

// One batch tick across every registered handler type — same "poll on an
// interval" shape automation/eventQueue.js already uses for workflow
// execution, generalized to any job type so a slow job in one type doesn't
// starve the others (claimNext() picks the oldest, highest-priority due job
// across all registered types, not round-robin per type).
export async function processJobsTick(batchSize = 5) {
  const provider = getQueueProvider();
  const types = Array.from(HANDLERS.keys());
  if (types.length === 0) return;
  for (let i = 0; i < batchSize; i++) {
    const job = provider.claimNext(types);
    if (!job) break;
    const handler = HANDLERS.get(job.type);
    try {
      const result = await handler(JSON.parse(job.payload || "{}"), {
        jobId: job.id,
        attempt: job.attempts,
        reportProgress: (pct, note) => reportProgress(job.id, pct, note),
      });
      provider.complete(job.id, result);
    } catch (err) {
      provider.fail(job.id, { error: err.message, retryable: err.retryable !== false });
    }
  }
}

let intervalHandle = null;
export function initializeJobProcessor(intervalMs = 3000) {
  if (intervalHandle) return; // idempotent — don't stack multiple tickers on hot-reload
  intervalHandle = setInterval(() => {
    processJobsTick().catch((err) => console.error("Job tick error:", err.message));
  }, intervalMs);
}
