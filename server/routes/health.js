// Health checks (Phase 16 §11) — liveness/readiness are intentionally public
// and minimal (infra probes generally can't authenticate); every deeper
// diagnostic endpoint requires platform-admin, since queue depth,
// circuit-breaker state, and per-provider detail are operational
// information that shouldn't be handed to an unauthenticated prober even
// though none of it is a secret in the credentials sense.
import { Router } from "express";
import Redis from "ioredis";
import { requireAuth, requirePlatformAdmin } from "../middleware.js";
import db from "../db.js";
import { providerStatus } from "../ai/provider.js";
import { imageProviderStatus } from "../ai/imageProvider.js";
import { sttStatus, ttsStatus } from "../ai/speech.js";
import { videoProviderStatus } from "../ai/videoProvider.js";
import { audioProviderStatus } from "../ai/audioProvider.js";
import { storageStatus } from "../storage/provider.js";
import { queueProviderStatus } from "../jobs/queueProvider.js";
import { createJob, getJob, jobStats, processJobsTick } from "../jobs/jobManager.js";
import { cacheProviderStatus, getCacheProvider } from "../orchestrator/cacheProvider.js";
import { rateLimiterStatus } from "../orchestrator/rateLimiter.js";
import { logger } from "../config/logger.js";

const router = Router();

// A dedicated, lazily-created client for connectivity checks only — every
// *_PROVIDER=redis setting shares one REDIS_URL, so one PING answers "is
// Redis actually reachable right now" for the cache/rate-limiter/queue/
// session-store providers all at once, without reaching into each
// provider's own private client.
let redisHealthClient = null;
async function redisHealth() {
  if (!process.env.REDIS_URL) return { configured: false, ok: null, reason: "REDIS_URL is not set" };
  try {
    if (!redisHealthClient) {
      redisHealthClient = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2000, lazyConnect: false });
      redisHealthClient.on("error", () => {}); // handled per-call below via the ping() try/catch — avoid an unhandled 'error' event crashing the process
    }
    const start = Date.now();
    const pong = await redisHealthClient.ping();
    return { configured: true, ok: pong === "PONG", latencyMs: Date.now() - start };
  } catch (err) {
    return { configured: true, ok: false, reason: "unreachable" };
  }
}

// --- Public: liveness/readiness only, no operational detail. ---

// Also exported standalone (see liveReadyRoutes below) so index.js can
// mount JUST these two routes before session/rate-limit middleware —
// found via Phase 19's Redis-outage failure testing that mounting the
// FULL router that early broke requireAuth below (req.session doesn't
// exist yet that early), while leaving it at its original later position
// made liveness/readiness themselves depend on Redis through the session/
// rate-limiter middleware that runs before this router. Kept here too
// (reachable at the same paths through the main router) purely so nothing
// that already imports the default export and expects /live to exist
// breaks — in practice index.js's early liveReadyRoutes mount always
// answers these two first.

// Is the process itself running and able to respond at all? No dependency
// checks — a DB outage should NOT make this fail, or an orchestrator would
// kill and restart a perfectly-fine process that's correctly reporting
// "not ready" via /health/ready instead.
router.get("/live", (req, res) => res.json({ ok: true }));

// Is the app ready to actually serve real requests? Checks the one
// dependency nothing here works without — the database.
router.get("/ready", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, reason: "database" });
  }
});

export const liveReadyRoutes = Router();
liveReadyRoutes.get("/live", (req, res) => res.json({ ok: true }));
liveReadyRoutes.get("/ready", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, reason: "database" });
  }
});

router.use(requireAuth, requirePlatformAdmin);

// --- Admin-only: real diagnostic detail. ---

router.get("/database", (req, res) => {
  const start = Date.now();
  try {
    db.prepare("SELECT 1").get();
    const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    res.json({ ok: true, latencyMs: Date.now() - start, userCount });
  } catch (err) {
    // Never the raw driver error in the response — even to an admin, that
    // can include the on-disk file path or other internal detail no
    // consumer of this endpoint needs. The real message still goes to the
    // server's own structured logs for whoever's actually debugging it.
    logger.error("health.database_check_failed", { requestId: req.requestId, errorCode: err.code || "DB_ERROR" });
    res.status(503).json({ ok: false, latencyMs: Date.now() - start, error: "Database check failed." });
  }
});

router.get("/redis", async (req, res) => {
  res.json(await redisHealth());
});

router.get("/queue", async (req, res) => {
  const automationQueueCounts = db.prepare(
    "SELECT status, COUNT(*) c FROM automation_event_queue GROUP BY status"
  ).all().reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

  // A real end-to-end check, not just a status read: enqueue a job, process
  // one tick, confirm it actually completed. Proves the queue is moving,
  // not just that the table is reachable.
  const start = Date.now();
  let selfTestOk = false;
  let selfTestError = null;
  try {
    const job = createJob({ type: "system.selftest", payload: { healthCheck: true } });
    await processJobsTick(1);
    const completed = getJob(job.id);
    selfTestOk = completed?.status === "completed";
    if (!selfTestOk) selfTestError = completed?.error || `unexpected status: ${completed?.status}`;
  } catch (err) {
    selfTestError = err.message;
  }

  res.json({
    ok: selfTestOk,
    selfTestLatencyMs: Date.now() - start,
    selfTestError,
    provider: queueProviderStatus(),
    jobs: jobStats(),
    automationQueue: automationQueueCounts,
  });
});

router.get("/storage", (req, res) => res.json({ ok: true, ...storageStatus() }));

router.get("/ai", (req, res) => {
  res.json({
    text: providerStatus(),
    image: imageProviderStatus(),
    video: videoProviderStatus(),
    audio: audioProviderStatus(),
    stt: sttStatus(),
    tts: ttsStatus(),
  });
});

router.get("/integrations", (req, res) => {
  const rows = db.prepare(
    "SELECT provider, status, COUNT(*) c FROM integrations GROUP BY provider, status"
  ).all();
  const byProvider = {};
  for (const r of rows) {
    byProvider[r.provider] = byProvider[r.provider] || {};
    byProvider[r.provider][r.status] = r.c;
  }
  res.json({ ok: true, byProvider });
});

// A single rollup of everything above, for a one-request dashboard view.
router.get("/", async (req, res) => {
  const dbOk = (() => { try { db.prepare("SELECT 1").get(); return true; } catch { return false; } })();
  const cacheEntry = getCacheProvider();
  let cacheEntries = null;
  if (cacheEntry.configured) {
    try {
      cacheEntries = await cacheEntry.size();
    } catch (err) {
      cacheEntries = null;
    }
  }
  res.json({
    ok: dbOk,
    database: dbOk,
    storage: storageStatus(),
    queue: { provider: queueProviderStatus(), jobs: jobStats() },
    ai: { text: providerStatus(), image: imageProviderStatus(), stt: sttStatus(), tts: ttsStatus() },
    cache: { ...cacheProviderStatus(), entries: cacheEntries },
    rateLimiter: rateLimiterStatus(),
    redis: await redisHealth(),
  });
});

export default router;
