// Centralized rate limiting (Phase 16 §5/§6) — a Rate Limiter Provider
// abstraction, same REGISTRY-of-adapters shape as queueProvider.js and the
// AI provider abstractions, so nothing that calls checkLimit() depends on
// whether counters live in-process or in a real distributed store.
//
// The in-process adapter is real and works today (fixed-window counters in
// a Map, swept on an interval so memory doesn't grow unbounded) but is
// per-server-process — fine for this single-instance deployment, NOT
// sufficient once the app runs as more than one process/node, at which
// point a Redis-backed adapter (sharing counters across processes) is a
// straight drop-in via this same interface.
import db from "../db.js";

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

function notConfigured() {
  const err = new Error(
    "The Redis rate limiter is not configured — this is architecture only. " +
    "Install ioredis, implement this adapter against a real Redis instance, and set REDIS_URL. " +
    "Until then, leave RATE_LIMIT_PROVIDER unset (or 'in_memory') to use the working per-process limiter."
  );
  err.code = "PROVIDER_NOT_CONFIGURED";
  throw err;
}
const RedisRateLimiter = { name: "redis", configured: false, check: notConfigured };

const REGISTRY = { in_memory: InMemoryRateLimiter, redis: RedisRateLimiter };

function getProvider() {
  const configured = (process.env.RATE_LIMIT_PROVIDER || "in_memory").toLowerCase();
  return REGISTRY[configured] || InMemoryRateLimiter;
}

// Exposes the same underlying check() every middleware below already uses —
// for callers (Phase 17's Public API) that need full control over the
// response shape (custom headers, a different error body) rather than one
// of the ready-made middlewares here. Still exactly one rate-limiting
// engine either way, never a second one.
export function checkRateLimit(key, opts) {
  return getProvider().check(key, opts);
}

export function rateLimiterStatus() {
  const entry = getProvider();
  return { provider: entry.name, configured: entry.configured, reason: entry.configured ? null : "Requires REDIS_URL and ioredis — not present in this environment." };
}

// Express middleware factory. `keyFn(req)` derives the bucket key (per-IP,
// per-user, per-org, per-endpoint, ...); returning null/undefined from
// keyFn skips rate limiting for that request entirely (e.g. no session yet).
export function rateLimit({ windowMs, max, keyFn, label = "rate_limit" }) {
  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const result = getProvider().check(`${label}:${key}`, { windowMs, max });
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "Too many requests — please slow down and try again shortly.", retryAfterSeconds });
    }
    next();
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
  return (req, res, next) => {
    const userId = req.session?.userId;
    if (!userId) return next(); // requireAuth (mounted before this) already rejects unauthenticated requests
    const orgId = req.body?.orgId || req.query?.orgId;
    const max = aiBurstLimitForOrg(orgId);
    const key = `${label}:${userId}`;
    const result = getProvider().check(key, { windowMs, max });
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "You're sending AI requests too quickly — please wait a moment and try again.", retryAfterSeconds });
    }
    next();
  };
}
