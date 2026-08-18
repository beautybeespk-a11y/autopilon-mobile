// Queue Provider abstraction (Phase 16, Phase 18 §8/§9) — nothing outside
// this file talks to the job backing store directly. Mirrors the exact
// pattern ai/imageProvider.js and ai/speech.js already use for AI vendors: a
// REGISTRY of named providers, each with the same method surface.
//
// jobManager.js's createJob()/cancelJob()/retryJob()/pauseJob()/resumeJob()/
// reportProgress() are called synchronously from deep inside core business
// logic — orchestrator/webhookEvents.js's publishDeveloperWebhookEvent()
// alone is called synchronously from task/content/file/automation/agent/
// cost-control code across 8+ files. A real Redis client is unavoidably
// async, so — same reasoning as orchestrator/cacheProvider.js's
// cached()/syncProvider() split — jobManager.js is wired to syncProvider()
// below, which ALWAYS returns InProcessQueueProvider, regardless of
// QUEUE_PROVIDER. Converting those call sites to async would mean
// rewriting core business logic, which Phase 18's rules explicitly forbid.
//
// That said, InProcessQueueProvider is real, SQLite-backed, WAL-mode
// durable storage (db.js enables `journal_mode = WAL`), and WAL mode
// natively supports multiple OS processes reading/writing the same file
// concurrently — so real horizontal *job-processing* scaling (multiple
// worker.js processes claiming from the same queue) already works without
// Redis at all; see worker.js. RedisQueueProvider below is a real,
// separately-tested implementation for genuinely distributed (multi-
// machine) deployments or future async-first code — available via
// getQueueProvider() when QUEUE_PROVIDER=redis, not used by jobManager.js's
// existing synchronous call sites.
import Redis from "ioredis";
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

  // A job claimed by a worker that then CRASHES (killed, OOM, power loss —
  // not a graceful SIGTERM, which stops claiming new work but lets an
  // in-flight handler finish) is left at status='running' forever: nothing
  // else here ever transitions a 'running' job back out on its own. Found
  // via Phase 19's required worker-crash failure testing (§36 — "must not
  // lose important jobs silently"), fixed the same way a normal failure
  // is handled: retry with the existing backoff schedule if attempts
  // remain, otherwise dead-letter, both explicitly distinguishable in the
  // job's error message from an ordinary handler failure.
  reclaimStale(timeoutMs) {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const stale = db.prepare("SELECT * FROM jobs WHERE status = 'running' AND startedAt <= ?").all(cutoff);
    for (const job of stale) {
      if (job.attempts < job.maxAttempts) {
        const backoffSeconds = Math.min(2 ** job.attempts * 2, 300);
        const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        db.prepare("UPDATE jobs SET status = 'queued', error = ?, errorRetryable = 1, nextAttemptAt = ? WHERE id = ? AND status = 'running'")
          .run(`Reclaimed: the worker holding this job did not complete it within ${timeoutMs}ms (crashed or was killed).`, nextAttemptAt, job.id);
      } else {
        db.prepare("UPDATE jobs SET status = 'dead_letter', error = ?, errorRetryable = 1, completedAt = ? WHERE id = ? AND status = 'running'")
          .run(`Reclaimed: the worker holding this job did not complete it within ${timeoutMs}ms (crashed or was killed), and max attempts was already reached.`, now(), job.id);
      }
    }
    return stale.length;
  },
};

// Always the in-process/SQLite provider, never REGISTRY-selected — see the
// file-level comment above. jobManager.js's public API goes through this.
export function syncProvider() {
  return InProcessQueueProvider;
}

function requireRedisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) {
    const err = new Error(
      "REDIS_URL is not set — required when QUEUE_PROVIDER=redis. " +
      "Set it (e.g. redis://localhost:6379) or leave QUEUE_PROVIDER unset (or 'in_process') to use the working in-process queue."
    );
    err.code = "PROVIDER_NOT_CONFIGURED";
    throw err;
  }
  return url;
}

let redisClient = null;
function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis(requireRedisUrl(), { maxRetriesPerRequest: 2 });
    redisClient.on("error", (err) => console.error("[queueProvider] Redis connection error:", err.message));
  }
  return redisClient;
}

const RQ_PREFIX = "rq:";
const jobKey = (id) => `${RQ_PREFIX}job:${id}`;
const pendingKey = (type) => `${RQ_PREFIX}pending:${type}`;
const idemKey = (key) => `${RQ_PREFIX}idem:${key}`;

// Score = dueAt (ms epoch), nudged earlier by up to ~1s per priority point
// so higher-priority jobs jump ahead of same-instant lower-priority ones,
// without breaking real due-time/backoff scheduling (which differs by
// seconds+, not milliseconds). A real, if simplified, approximation of
// InProcessQueueProvider's `ORDER BY priority DESC, createdAt ASC`.
function score(dueAtMs, priority) {
  return dueAtMs - (priority || 0) * 1000;
}

// Atomically claims the single best (earliest-due, across every given
// type's pending set) job: for each candidate type, peeks the lowest-score
// member due by `now`, keeps the global best, then ZREMs only that one
// member. The ZREM happening inside the same script as the scan is what
// makes this safe against two workers racing claimNext() at once — only
// one of them can win the ZREM for a given jobId, same "only the SQL
// UPDATE ... WHERE status = 'queued' winner proceeds" guarantee
// InProcessQueueProvider gets from SQLite for free.
const CLAIM_NEXT_SCRIPT = `
local now = tonumber(ARGV[1])
local bestKey = nil
local bestJobId = nil
local bestScore = nil
for i, key in ipairs(KEYS) do
  local results = redis.call('ZRANGEBYSCORE', key, '-inf', now, 'WITHSCORES', 'LIMIT', 0, 1)
  if results[1] then
    local jobId = results[1]
    local s = tonumber(results[2])
    if bestScore == nil or s < bestScore then
      bestScore = s
      bestJobId = jobId
      bestKey = key
    end
  end
end
if not bestJobId then
  return nil
end
redis.call('ZREM', bestKey, bestJobId)
return bestJobId
`;

async function readJobHash(client, id) {
  const h = await client.hgetall(jobKey(id));
  if (!h || !h.id) return null;
  return {
    id: h.id, type: h.type, status: h.status,
    priority: Number(h.priority || 0),
    orgId: h.orgId || null, workspaceId: h.workspaceId || null, userId: h.userId || null,
    agentId: h.agentId || null, automationId: h.automationId || null,
    payload: h.payload || "{}",
    maxAttempts: Number(h.maxAttempts || 3), attempts: Number(h.attempts || 0),
    idempotencyKey: h.idempotencyKey || null,
    error: h.error || null, errorRetryable: h.errorRetryable ? Number(h.errorRetryable) : null,
    progress: Number(h.progress || 0), progressNote: h.progressNote || null,
    result: h.result || null,
    createdAt: h.createdAt, startedAt: h.startedAt || null, completedAt: h.completedAt || null,
    nextAttemptAt: h.nextAttemptAt || null,
  };
}

function hsetCompact(fields) {
  // ioredis' hset rejects undefined/null values — strip them and let the
  // field simply not exist yet rather than writing the string "null".
  const flat = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    flat.push(k, String(v));
  }
  return flat;
}

// Real, ioredis-backed implementation. Field-compatible with the SQLite
// jobs table row shape jobManager.js's withJson() already parses (payload/
// result as JSON strings) so a future switch-over wouldn't need a second
// translation layer, even though nothing wires this in by default today.
const RedisQueueProvider = {
  name: "redis",
  get configured() {
    return Boolean(process.env.REDIS_URL);
  },

  async enqueue({ type, orgId, workspaceId, userId, agentId, automationId, payload, priority = 0, maxAttempts = 3, idempotencyKey }) {
    const client = getRedisClient();
    if (idempotencyKey) {
      const existingId = await client.get(idemKey(idempotencyKey));
      if (existingId) {
        const existing = await readJobHash(client, existingId);
        if (existing) return existing;
      }
    }
    const id = cryptoRandom();
    const createdAt = new Date().toISOString();
    const nowMs = Date.now();
    await client.hset(
      jobKey(id),
      ...hsetCompact({
        id, type, status: "queued", priority,
        orgId, workspaceId, userId, agentId, automationId,
        payload: JSON.stringify(payload || {}),
        maxAttempts, attempts: 0, idempotencyKey,
        createdAt,
      })
    );
    await client.zadd(pendingKey(type), score(nowMs, priority), id);
    if (idempotencyKey) await client.set(idemKey(idempotencyKey), id);
    return readJobHash(client, id);
  },

  async claimNext(types) {
    const client = getRedisClient();
    const keys = types.map(pendingKey);
    const jobId = await client.eval(CLAIM_NEXT_SCRIPT, keys.length, ...keys, Date.now());
    if (!jobId) return null;
    const startedAt = new Date().toISOString();
    const job = await readJobHash(client, jobId);
    if (!job) return null; // job hash vanished (shouldn't happen) — treat as no job claimed
    const attempts = job.attempts + 1;
    await client.hset(jobKey(jobId), ...hsetCompact({ status: "running", attempts, startedAt }));
    return { ...job, status: "running", attempts, startedAt };
  },

  async complete(jobId, result) {
    const client = getRedisClient();
    await client.hset(jobKey(jobId), ...hsetCompact({
      status: "completed", result: JSON.stringify(result ?? null), progress: 100, completedAt: new Date().toISOString(),
    }));
  },

  async fail(jobId, { error, retryable = true }) {
    const client = getRedisClient();
    const job = await readJobHash(client, jobId);
    if (!job) return;
    if (retryable && job.attempts < job.maxAttempts) {
      const backoffSeconds = Math.min(2 ** job.attempts * 2, 300);
      const nextAttemptAtMs = Date.now() + backoffSeconds * 1000;
      await client.hset(jobKey(jobId), ...hsetCompact({
        status: "queued", error, errorRetryable: 1, nextAttemptAt: new Date(nextAttemptAtMs).toISOString(),
      }));
      await client.zadd(pendingKey(job.type), score(nextAttemptAtMs, job.priority), jobId);
    } else {
      await client.hset(jobKey(jobId), ...hsetCompact({
        status: retryable ? "dead_letter" : "failed", error, errorRetryable: retryable ? 1 : 0, completedAt: new Date().toISOString(),
      }));
    }
  },

  async cancel(jobId) {
    const client = getRedisClient();
    const job = await readJobHash(client, jobId);
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return false;
    if (job.status === "queued") await client.zrem(pendingKey(job.type), jobId);
    await client.hset(jobKey(jobId), ...hsetCompact({ status: "cancelled", completedAt: new Date().toISOString() }));
    return true;
  },

  async retry(jobId) {
    const client = getRedisClient();
    const job = await readJobHash(client, jobId);
    if (!job || !["failed", "dead_letter"].includes(job.status)) return false;
    await client.hset(jobKey(jobId), ...hsetCompact({ status: "queued", attempts: 0, error: "", nextAttemptAt: "" }));
    await client.hdel(jobKey(jobId), "error", "nextAttemptAt");
    await client.zadd(pendingKey(job.type), score(Date.now(), job.priority), jobId);
    return true;
  },

  async pause(jobId) {
    const client = getRedisClient();
    const job = await readJobHash(client, jobId);
    if (!job || job.status !== "queued") return false;
    await client.zrem(pendingKey(job.type), jobId);
    await client.hset(jobKey(jobId), ...hsetCompact({ status: "paused" }));
    return true;
  },

  async resume(jobId) {
    const client = getRedisClient();
    const job = await readJobHash(client, jobId);
    if (!job || job.status !== "paused") return false;
    await client.hset(jobKey(jobId), ...hsetCompact({ status: "queued" }));
    await client.zadd(pendingKey(job.type), score(Date.now(), job.priority), jobId);
    return true;
  },

  async progress(jobId, percent, note) {
    const client = getRedisClient();
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await client.hset(jobKey(jobId), ...hsetCompact({ progress: clamped, progressNote: note || "" }));
  },

  // Test/inspection only — not part of the InProcessQueueProvider surface.
  async getJob(jobId) {
    return readJobHash(getRedisClient(), jobId);
  },

  // NOT IMPLEMENTED — no reclaimStale() here, unlike InProcessQueueProvider.
  // A correct version needs an index of running jobs by startedAt (Redis
  // has no "WHERE status = X AND startedAt <= Y" query without one), which
  // is a real, if bounded, addition, not a one-line port of the SQLite
  // version above. Left undone since this provider isn't wired into the
  // live job pipeline today (see this file's own header comment) — build
  // it before ever actually switching QUEUE_PROVIDER=redis into the real
  // path, not before.
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
