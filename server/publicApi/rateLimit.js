// Public API rate limiting (Phase 17 §19) — reuses the exact same engine
// Phase 16 already built (orchestrator/rateLimiter.js's checkRateLimit(),
// the same fixed-window in-process/Redis-stub provider every other rate
// limit in the app goes through), just with the three response headers the
// spec calls for and the Phase 17 consistent error shape, keyed by API key
// rather than session/IP.
import db from "../db.js";
import { checkRateLimit, concurrencyLimit } from "../orchestrator/rateLimiter.js";
import { apiError } from "./errors.js";

// Plan-derived, same spirit as rateLimiter.js's aiBurstLimitForOrg (same
// direct-query-of-subscriptions approach, deliberately not routed through
// billing.js, to avoid a needless cross-module dependency for a one-column
// lookup) — a public API caller on a higher plan gets a higher per-minute
// ceiling. Deliberately generous relative to the AI burst limits (most
// public API calls are cheap reads, not AI generations, which get their
// own additional limiter at the route level via aiRateLimit()/
// aiConcurrencyLimit(), same as the internal API).
const PLAN_LIMITS = { free: 60, starter: 120, professional: 300, business: 600, enterprise: 1200 };
const DEFAULT_LIMIT = 60;

function planLimitForOrg(orgId) {
  if (!orgId) return DEFAULT_LIMIT;
  const sub = db.prepare("SELECT planId FROM subscriptions WHERE orgId = ?").get(orgId);
  return PLAN_LIMITS[sub?.planId] ?? DEFAULT_LIMIT;
}

export function apiRateLimit({ windowMs = 60_000, label = "public_api" } = {}) {
  return async (req, res, next) => {
    if (!req.apiKey) return next(); // requireApiKey (mounted before this) already rejects an unauthenticated request
    const max = planLimitForOrg(req.orgId);
    const key = `${label}:${req.apiKey.id}`;
    try {
      const result = await checkRateLimit(key, { windowMs, max });
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", String(result.remaining));
      res.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000))); // unix seconds, matches Retry-After's unit family
      if (!result.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
        res.set("Retry-After", String(retryAfterSeconds));
        return apiError(res, 429, "RATE_LIMITED", `Too many requests for this API key — retry after ${retryAfterSeconds}s.`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// AI-heavy public API routes (agent execute/messages, content generation)
// stack this on top of apiRateLimit() — a per-key in-flight cap, same
// purpose as Phase 16's aiConcurrencyLimit() but keyed by API key id
// instead of req.session.userId, which is never set for API-key auth (that
// middleware would silently no-op here — keyFn returning undefined skips
// the check entirely, exactly the same class of gap apiRateLimit() above
// was written to avoid for per-minute limiting). Reuses the same
// concurrencyLimit() factory Phase 16 built; its 429 body isn't in the
// Phase 17 {error:{code,...}} shape (no customization hook exists for
// it), a minor, deliberate inconsistency rather than duplicating Phase
// 16's tested acquire/release logic just to reformat one error string.
const AI_MAX_CONCURRENT_PER_KEY = 3;
export function apiAiConcurrencyLimit() {
  return concurrencyLimit({ max: AI_MAX_CONCURRENT_PER_KEY, keyFn: (req) => req.apiKey?.id, label: "public_api_ai_concurrent" });
}

export { PLAN_LIMITS, DEFAULT_LIMIT };
