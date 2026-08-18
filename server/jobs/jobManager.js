// Centralized Job Manager (Phase 16 §2, Phase 18 §8) — the one place that
// creates, tracks, and drives background work, sitting on top of the Queue
// Provider abstraction (queueProvider.js). Deliberately wired to
// syncProvider() (always the in-process/SQLite adapter), not the
// QUEUE_PROVIDER-selected one — see queueProvider.js's file-level comment
// for why. This module's own processing loop (processJobsTick()/
// initializeJobProcessor()) is reused as-is by both the main API server
// (inline) and worker.js (standalone) — real multi-process horizontal
// scaling comes from running more than one of those, all pointed at the
// same WAL-mode SQLite file, not from a different queue backend.
import db from "../db.js";
import { syncProvider } from "./queueProvider.js";

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
  const job = syncProvider().enqueue({ type, orgId, workspaceId, userId, agentId, automationId, payload, priority, maxAttempts, idempotencyKey });
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

export const cancelJob = (id) => syncProvider().cancel(id);
export const retryJob = (id) => syncProvider().retry(id);
export const pauseJob = (id) => syncProvider().pause(id);
export const resumeJob = (id) => syncProvider().resume(id);
export const reportProgress = (id, percent, note) => syncProvider().progress(id, percent, note);

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
// A worker that crashes (killed, OOM, power loss) mid-job leaves it
// claimed (status='running') with nobody left to finish or retry it —
// found via Phase 19's required worker-crash failure testing. Reclaimed
// once it's been running longer than this, using the provider's own
// retry/dead-letter branching (see queueProvider.js's reclaimStale()).
const STALE_RUNNING_TIMEOUT_MS = Number(process.env.JOB_STALE_TIMEOUT_MS) || 10 * 60 * 1000;

export async function processJobsTick(batchSize = 5) {
  const provider = syncProvider();
  const types = Array.from(HANDLERS.keys());
  if (types.length === 0) return;
  provider.reclaimStale?.(STALE_RUNNING_TIMEOUT_MS);
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

// Graceful shutdown (Phase 18 §8/§31): stops scheduling new ticks. Does NOT
// wait for an in-flight processJobsTick() batch to finish — callers that
// need that (worker.js) track the in-flight promise themselves, since a
// setInterval handle alone can't express "and wait for the current one".
export function stopJobProcessor() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
