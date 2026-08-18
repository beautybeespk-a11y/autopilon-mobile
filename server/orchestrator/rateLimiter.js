// Centralized rate limiting (Phase 16 §5/§6, Phase 18 §7/§19) — a Rate
// Limiter Provider abstraction, same REGISTRY-of-adapters shape as
// queueProvider.js and the AI provider abstractions, so nothing that calls
// checkRateLimit()/rateLimit()/aiRateLimit() depends on whether counters
// live in-process or in a real distributed store.
//
// The in-process adapter is real and works today (fixed-window counters in
// a Map, swept on an interval so memory doesn't grow unbounded) but is
// per-server-process — fine for a single-instance deployment, NOT
// sufficient once the app runs as more than one process/node. RATE_LIMIT_
// PROVIDER=redis selects a real ioredis-backed adapter (INCR+PEXPIRE fixed
// window) that shares counters across every process pointed at the same
// REDIS_URL. All three call sites below are Express middleware/pure
// request-scoped checks with no synchronous business-logic caller beneath
// them, so converting check() to async here is safe end-to-end — unlike
// cacheProvider.js's cached(), which stays permanently synchronous because
// its callers cascade into billing's enforceQuota().
import Redis from "ioredis";
import db from "../db.js";
import { logger } from "../config/logger.js";

const WINDOW_SWEEP_INTERVAL_MS = 60_000;

// key -> { count, resetAt }
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, WINDOW_SWEEP_INTERVAL_MS).unref?.();

const InMemoryRateLimiter = {
  name: "in_memory",
  configured: true,
  // Fixed-window counter: returns { allowed, remaining, resetAt }.
  check(key, { windowMs, max }) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { allowed: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetAt: bucket.resetAt };
  },
};

function requireRedisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) {
    const err = new Error(
      "REDIS_URL is not set — required when RATE_LIMIT_PROVIDER=redis. " +
      "Set it (e.g. redis://localhost:6379) or leave RATE_LIMIT_PROVIDER unset (or 'in_memory') to use the working per-process limiter."
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
    redisClient.on("error", (err) => console.error("[rateLimiter] Redis connection error:", err.message));
  }
  return redisClient;
}

// Real, ioredis-backed fixed-window limiter: INCR the window's counter key,
// set its expiry only on the first increment in that window (so later
// increments don't keep pushing the reset time out), read back the
// remaining TTL to compute resetAt. Shares counts across every process
// pointed at the same REDIS_URL — the whole reason to select this over
// InMemoryRateLimiter once the app runs as more than one process.
const RedisRateLimiter = {
  name: "redis",
  get configured() {
    return Boolean(process.env.REDIS_URL);
  },
  async check(key, { windowMs, max }) {
    const client = getRedisClient();
    const redisKey = `ratelimit:${key}`;
    try {
      const count = await client.incr(redisKey);
      if (count === 1) await client.pexpire(redisKey, windowMs);
      const ttl = await client.pttl(redisKey);
      const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
      return { allowed: count <= max, remaining: Math.max(0, max - count), resetAt };
    } catch (err) {
      // Fail OPEN, not closed. Found via Phase 19's real Redis-outage
      // failure testing: this same limiter is applied to literally every
      // /api/* request (index.js's global limiter), so failing closed here
      // meant a Redis blip took down 100% of API traffic with 500s — a far
      // worse outcome than briefly running without rate limiting. A
      // temporarily-unenforced abuse guard during a real infrastructure
      // outage is an acceptable trade against a total self-inflicted
      // outage; logged as degraded so it's visible in monitoring, not
      // silent. This does not apply to authentication/authorization checks
      // elsewhere, which correctly stay fail-closed.
      logger.warn("rate_limiter.redis_unavailable_failing_open", { key, error: err.message });
      return { allowed: true, remaining: max, resetAt: Date.now() + windowMs, degraded: true };
    }
  },
};

const REGISTRY = { in_memory: InMemoryRateLimiter, redis: RedisRateLimiter };

function getProvider() {
  const configured = (process.env.RATE_LIMIT_PROVIDER || "in_memory").toLowerCase();
  return REGISTRY[configured] || InMemoryRateLimiter;
}

// Exposes the same underlying check() every middleware below already uses —
// for callers (Phase 17's Public API) that need full control over the
// response shape (custom headers, a different error body) rather than one
// of the ready-made middlewares here. Still exactly one rate-limiting
// engine either way, never a second one. async because the redis provider's
// check() is a real network round-trip; InMemoryRateLimiter's synchronous
// return value awaits through unchanged.
export async function checkRateLimit(key, opts) {
  return await getProvider().check(key, opts);
}

export function rateLimiterStatus() {
  const entry = getProvider();
  return { provider: entry.name, configured: entry.configured, reason: entry.configured ? null : "Requires REDIS_URL and ioredis — not present in this environment." };
}

// Express middleware factory. `keyFn(req)` derives the bucket key (per-IP,
// per-user, per-org, per-endpoint, ...); returning null/undefined from
// keyFn skips rate limiting for that request entirely (e.g. no session yet).
export function rateLimit({ windowMs, max, keyFn, label = "rate_limit" }) {
  return async (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    try {
      const result = await getProvider().check(`${label}:${key}`, { windowMs, max });
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
        res.set("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({ error: "Too many requests — please slow down and try again shortly.", retryAfterSeconds });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Plan-derived burst ceilings for expensive AI endpoints — deliberately a
// small in-code map rather than a new plans.* column: this is a short-window
// abuse guard (requests/minute), not a billing quantity, and every plan
// tier already exists as a fixed, known set of ids (see db.js's seeded
// plans) so there's nothing per-org to customize here yet. The real
// monthly ceiling (plans.maxAiRequests) is enforced separately and already
// exists — see orchestrator/billing.js's enforceQuota().
const AI_BURST_LIMITS = { free: 10, starter: 20, professional: 60, business: 120, enterprise: 300 };
const DEFAULT_AI_BURST_LIMIT = 20;

export function aiBurstLimitForOrg(orgId) {
  if (!orgId) return DEFAULT_AI_BURST_LIMIT;
  const sub = db.prepare("SELECT planId FROM subscriptions WHERE orgId = ?").get(orgId);
  return AI_BURST_LIMITS[sub?.planId] ?? DEFAULT_AI_BURST_LIMIT;
}

// --- Concurrency control (§6) — distinct from the rate-over-time limiters
// above: this caps how many operations for a given key are IN FLIGHT AT
// ONCE, so one org/user/agent can't monopolize the process by firing off
// many slow generations in parallel, even if each individual request is
// well under the per-minute rate limit. In-memory only (per-process, same
// caveat as the rate limiter) — a real distributed deployment would need
// this tracked centrally (e.g. Redis counters), which is exactly the kind
// of thing the queue provider's job concurrency would naturally enforce
// once long-running generation actually moves onto it.
const inFlight = new Map(); // key -> count

function acquire(key, max) {
  const current = inFlight.get(key) || 0;
  if (current >= max) return null;
  inFlight.set(key, current + 1);
  // Idempotent — Node fires both 'finish' and 'close' on a normal response
  // completion, and this must only decrement once per acquire().
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const c = inFlight.get(key) || 1;
    if (c <= 1) inFlight.delete(key);
    else inFlight.set(key, c - 1);
  };
}

// Express middleware. Releases the slot when the response finishes,
// errors, or the client disconnects early — never leaks a permanently
// "stuck" concurrency slot from a request that didn't cleanly res.json().
export function concurrencyLimit({ max, keyFn, label = "concurrency" }) {
  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const release = acquire(`${label}:${key}`, max);
    if (!release) {
      return res.status(429).json({ error: "Too many requests are already running for this account — wait for one to finish and try again." });
    }
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

export function concurrencyStats() {
  return Object.fromEntries(inFlight.entries());
}

// A fixed per-user concurrency cap for AI-heavy endpoints (image/voiceover/
// copy generation, chat, transcription) — 3 simultaneous in-flight
// generations is already generous for a single legitimate user and catches
// the realistic failure mode here (a buggy client retry-loop or a runaway
// script firing requests in parallel), not meant to be plan-differentiated
// the way the per-minute burst limit is.
const AI_MAX_CONCURRENT_PER_USER = 3;
export function aiConcurrencyLimit() {
  return concurrencyLimit({ max: AI_MAX_CONCURRENT_PER_USER, keyFn: (req) => req.session?.userId, label: "ai_concurrent" });
}

// A per-user+org AI-request burst limiter — the max is resolved per
// request (not fixed at middleware-creation time) since it depends on the
// caller's org/plan, unlike the flat limiters above.
export function aiRateLimit({ windowMs = 60_000, label = "ai_burst" } = {}) {
  return async (req, res, next) => {
    const userId = req.session?.userId;
    if (!userId) return next(); // requireAuth (mounted before this) already rejects unauthenticated requests
    const orgId = req.body?.orgId || req.query?.orgId;
    const max = aiBurstLimitForOrg(orgId);
    const key = `${label}:${userId}`;
    try {
      const result = await getProvider().check(key, { windowMs, max });
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
        res.set("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({ error: "You're sending AI requests too quickly — please wait a moment and try again.", retryAfterSeconds });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
