// Session store selection (Phase 18 §18) — express-session defaults to
// MemoryStore, which explicitly warns it isn't fit for production: it
// leaks memory over time, loses every session on a restart/deploy, and
// (like the in-process queue/cache/rate-limiter before Redis was wired up)
// only works correctly with exactly one server process. Unlike those,
// though, express-session's Store interface is callback-based and async by
// design — every store method takes a callback express-session itself
// awaits — so there's no sync/async blast-radius problem here: swapping
// stores is a real, safe drop-in with zero changes needed anywhere else.
//
// A tiny custom Store rather than the standard connect-redis package: this
// project has standardized on ioredis (already the client for the cache/
// rate-limiter/queue Redis providers), but connect-redis v10's peer
// dependency is specifically `redis` (node-redis) >= 5 — its commands use
// node-redis's object-options calling convention, which sends malformed
// commands ("ERR syntax error") when pointed at ioredis. Rather than pull
// in a second Redis client library for one store, this implements
// express-session's documented Store interface (get/set/destroy/touch)
// directly: https://github.com/expressjs/session#session-store-implementation
import session from "express-session";
import Redis from "ioredis";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // matches index.js's cookie maxAge (7 days) as a fallback

class RedisSessionStore extends session.Store {
  constructor(client, prefix) {
    super();
    this.client = client;
    this.prefix = prefix;
  }

  ttlSecondsFor(sessionData) {
    const maxAgeMs = sessionData?.cookie?.maxAge;
    if (typeof maxAgeMs === "number" && maxAgeMs > 0) return Math.ceil(maxAgeMs / 1000);
    return DEFAULT_TTL_SECONDS;
  }

  get(sid, callback) {
    this.client
      .get(this.prefix + sid)
      .then((raw) => callback(null, raw ? JSON.parse(raw) : null))
      .catch((err) => callback(err));
  }

  set(sid, sessionData, callback) {
    this.client
      .set(this.prefix + sid, JSON.stringify(sessionData), "EX", this.ttlSecondsFor(sessionData))
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  destroy(sid, callback) {
    this.client
      .del(this.prefix + sid)
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  // Refreshes TTL on activity without a full re-write — express-session
  // calls this on every request when resave/rolling behavior needs it.
  touch(sid, sessionData, callback) {
    this.client
      .expire(this.prefix + sid, this.ttlSecondsFor(sessionData))
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }
}

let redisClient = null;

// [OPTIONAL, has a default: memory] memory | redis. Set to "redis" (with
// REDIS_URL set) for any deployment that restarts the process, runs more
// than one process, or cares about a user staying logged in across a
// deploy — i.e. any real production deployment.
export function sessionStore() {
  const kind = (process.env.SESSION_STORE || "memory").toLowerCase();
  if (kind !== "redis") return undefined; // undefined = express-session's own default MemoryStore
  if (!process.env.REDIS_URL) {
    console.error("[sessionStore] SESSION_STORE=redis but REDIS_URL is not set — falling back to MemoryStore. Sessions will NOT survive a restart or scale past one process.");
    return undefined;
  }
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    redisClient.on("error", (err) => console.error("[sessionStore] Redis connection error:", err.message));
  }
  return new RedisSessionStore(redisClient, "sess:");
}
