// Queue Provider abstraction — nothing outside this file talks to the job
// backing store directly. Mirrors the exact pattern ai/imageProvider.js and
// ai/speech.js already use for AI vendors: a REGISTRY of named providers,
// each with the same method surface, so swapping the in-process adapter for
// a real distributed one (Redis/BullMQ) later means adding a new entry
// here, not touching call sites in jobManager.js or anywhere that enqueues
// work.
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();

function withJson(job) {
  return job || null;
}

// Durable across a restart (jobs live in SQLite, same durability guarantee
// automation/eventQueue.js already relies on for workflow execution) but
// NOT distributed — only this one server process claims and runs jobs.
// That's the real, honest characterization of "the durable but in-process
// execution queue" the platform has today.
const InProcessQueueProvider = {
  name: "in_process",
  configured: true,

  enqueue({ type, orgId, workspaceId, userId, agentId, automationId, payload, priority = 0, maxAttempts = 3, idempotencyKey }) {
    // Idempotency: a request that supplies a key and collides with an
    // existing job (any status) gets that job back instead of a duplicate
    // — the caller doesn't need to know whether this is a fresh enqueue or
    // a safe replay of one that already happened.
    if (idempotencyKey) {
      const existing = db.prepare("SELECT * FROM jobs WHERE idempotencyKey = ?").get(idempotencyKey);
      if (existing) return withJson(existing);
    }
    const id = cryptoRandom();
    db.prepare(
      `INSERT INTO jobs (id, type, status, priority, orgId, workspaceId, userId, agentId, automationId, payload, maxAttempts, idempotencyKey, createdAt)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, type, priority, orgId || null, workspaceId || null, userId || null, agentId || null, automationId || null, JSON.stringify(payload || {}), maxAttempts, idempotencyKey || null, now());
    return withJson(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  },

  // Atomic-enough for a single process: better-sqlite3 is synchronous, so
  // there's no await between the SELECT and the UPDATE ... WHERE status =
  // 'queued' guard below for another claimNext() call to race into.
  claimNext(types) {
    const nowIso = now();
    const placeholders = types.map(() => "?").join(",");
    const job = db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued' AND type IN (${placeholders}) AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
       ORDER BY priority DESC, createdAt ASC LIMIT 1`
    ).get(...types, nowIso);
    if (!job) return null;
    const claimed = db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, startedAt = ? WHERE id = ? AND status = 'queued'").run(nowIso, job.id);
    if (claimed.changes === 0) return null; // lost a race (shouldn't happen single-process, but don't assume)
    return withJson(db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id));
  },

  complete(jobId, result) {
    db.prepare("UPDATE jobs SET status = 'completed', result = ?, progress = 100, completedAt = ? WHERE id = ?").run(JSON.stringify(result ?? null), now(), jobId);
  },

  // retryable=false is how a handler signals "this failure is real and
  // repeating it would be dangerous/pointless" (spec §3: don't blindly
  // retry sending an email, charging a card, publishing an ad, etc.) —
  // those go straight to 'failed', not through the backoff/dead-letter path.
  fail(jobId, { error, retryable = true }) {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (!job) return;
    if (retryable && job.attempts < job.maxAttempts) {
      const backoffSeconds = Math.min(2 ** job.attempts * 2, 300); // exponential, capped at 5 minutes
      const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      db.prepare("UPDATE jobs SET status = 'queued', error = ?, errorRetryable = 1, nextAttemptAt = ? WHERE id = ?").run(error, nextAttemptAt, jobId);
    } else {
      db.prepare("UPDATE jobs SET status = ?, error = ?, errorRetryable = ?, completedAt = ? WHERE id = ?")
        .run(retryable ? "dead_letter" : "failed", error, retryable ? 1 : 0, now(), jobId);
    }
  },

  cancel(jobId) {
    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId);
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return false;
    db.prepare("UPDATE jobs SET status = 'cancelled', completedAt = ? WHERE id = ?").run(now(), jobId);
    return true;
  },

  // Only failed/dead_letter jobs are retryable via this explicit action —
  // a queued/running job doesn't need "retrying," and a completed/cancelled
  // one shouldn't silently re-run (that's a new enqueue, a deliberate call).
  retry(jobId) {
    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId);
    if (!job || !["failed", "dead_letter"].includes(job.status)) return false;
    db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, nextAttemptAt = NULL WHERE id = ?").run(jobId);
    return true;
  },

  pause(jobId) {
    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId);
    if (!job || job.status !== "queued") return false;
    db.prepare("UPDATE jobs SET status = 'paused' WHERE id = ?").run(jobId);
    return true;
  },

  resume(jobId) {
    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId);
    if (!job || job.status !== "paused") return false;
    db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(jobId);
    return true;
  },

  progress(jobId, percent, note) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    db.prepare("UPDATE jobs SET progress = ?, progressNote = ? WHERE id = ?").run(clamped, note || null, jobId);
  },
};

// Architecture-only. No ioredis/bullmq dependency is installed and no Redis
// instance exists in this environment — every method throws the same
// honest PROVIDER_NOT_CONFIGURED error the AI provider abstractions use,
// rather than silently degrading to the in-process adapter (that would
// hide a real infrastructure gap from whoever set QUEUE_PROVIDER=redis
// expecting distributed execution to actually be happening).
function notConfigured() {
  const err = new Error(
    "The Redis/BullMQ queue provider is not configured — this is architecture only. " +
    "Install the bullmq + ioredis packages, implement this adapter's methods against a real Redis instance, and set REDIS_URL. " +
    "Until then, leave QUEUE_PROVIDER unset (or 'in_process') to use the working in-process queue."
  );
  err.code = "PROVIDER_NOT_CONFIGURED";
  throw err;
}
const RedisQueueProvider = {
  name: "redis",
  configured: false,
  enqueue: notConfigured, claimNext: notConfigured, complete: notConfigured, fail: notConfigured,
  cancel: notConfigured, retry: notConfigured, pause: notConfigured, resume: notConfigured, progress: notConfigured,
};

const REGISTRY = { in_process: InProcessQueueProvider, redis: RedisQueueProvider };

function selectedProviderName() {
  const configured = (process.env.QUEUE_PROVIDER || "in_process").toLowerCase();
  return REGISTRY[configured] ? configured : "in_process";
}

export function getQueueProvider() {
  return REGISTRY[selectedProviderName()];
}

export function queueProviderStatus() {
  const entry = getQueueProvider();
  return {
    provider: entry.name,
    configured: entry.configured,
    reason: entry.configured ? null : "Requires REDIS_URL and the bullmq/ioredis packages — not present in this environment.",
    options: Object.values(REGISTRY).map((p) => ({ id: p.name, configured: p.configured })),
  };
}
