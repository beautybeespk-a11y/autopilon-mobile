// Cache Provider abstraction (Phase 16 §41, Phase 18 §7) — mirrors the
// exact pattern jobs/queueProvider.js already uses for the job backing
// store: a REGISTRY of named providers with the same method surface, so
// swapping the in-process adapter for a real distributed one (Redis) later
// means adding a new entry here, not touching most of this file's callers.
//
// Only for cheap-to-recompute, rarely-changing reads that get hit on a hot
// path (plan definitions, maintenance-mode status, feature flags) — NEVER
// for anything that must be immediately consistent across processes (usage
// counters, spend totals, quota checks) or that holds a secret.
//
// IMPORTANT: cached()/invalidate()/invalidatePrefix() below are used by
// billing.js's getPlan(), featureFlags.js's evaluationData()/
// isFeatureEnabled(), and maintenanceMode.js's maintenanceStatus() — all
// written and called fully synchronously, with maintenanceStatus() and
// isFeatureEnabled() sitting in front of enforceQuota()'s call graph
// (orchestrator/billing.js), which has 10+ synchronous callers including
// the core AI orchestrator. A real Redis client is unavoidably async
// (network I/O), so those three functions deliberately keep using
// syncProvider() below — always the in-process Map, regardless of
// CACHE_PROVIDER — rather than becoming async and forcing an unrelated
// rewrite of core quota-enforcement business logic (explicitly out of
// scope for Phase 18). getCacheProvider()/cachedAsync() below are the real,
// Redis-capable path for any future caller that's already async.
import Redis from "ioredis";

const store = new Map(); // key -> { value, expiresAt }

const InProcessCacheProvider = {
  name: "in_process",
  configured: true,

  get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  },

  set(key, value, ttlSeconds) {
    store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  },

  del(key) {
    store.delete(key);
  },

  // Deletes every key starting with `prefix` — used to invalidate a whole
  // family of derived cache entries (e.g. every "flag:<key>:*" scope combo)
  // in one call instead of tracking each exact key that was ever set.
  delPrefix(prefix) {
    for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
  },

  clear() {
    store.clear();
  },

  size() {
    return store.size;
  },
};

function requireRedisUrl() {
  const url = process.env.REDIS_URL;
  if (!url) {
    const err = new Error(
      "REDIS_URL is not set — required when CACHE_PROVIDER=redis. " +
      "Set it (e.g. redis://localhost:6379) or leave CACHE_PROVIDER unset (or 'in_process') to use the working in-process cache."
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
    redisClient.on("error", (err) => console.error("[cacheProvider] Redis connection error:", err.message));
  }
  return redisClient;
}

// All keys namespaced under "cache:" so delPrefix()/clear() can scope their
// SCAN to just this cache's keys and never touch other Redis users of the
// same REDIS_URL (the queue provider, the rate limiter).
const REDIS_KEY_PREFIX = "cache:";

async function scanDelete(pattern) {
  const client = getRedisClient();
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    if (keys.length) await client.del(...keys);
  } while (cursor !== "0");
}

// Real, ioredis-backed implementation — for genuinely async callers (see
// cachedAsync() below), not the three permanently-synchronous hot-path
// callers documented above. Values are JSON-serialized; TTL uses Redis's
// own EX expiry rather than a stored expiresAt, so entries actually vanish
// from Redis's memory instead of only being treated as expired on read.
const RedisCacheProvider = {
  name: "redis",
  get configured() {
    return Boolean(process.env.REDIS_URL);
  },

  async get(key) {
    const raw = await getRedisClient().get(REDIS_KEY_PREFIX + key);
    if (raw === null) return undefined;
    return JSON.parse(raw);
  },

  async set(key, value, ttlSeconds) {
    const client = getRedisClient();
    const serialized = JSON.stringify(value);
    if (ttlSeconds) await client.set(REDIS_KEY_PREFIX + key, serialized, "EX", ttlSeconds);
    else await client.set(REDIS_KEY_PREFIX + key, serialized);
  },

  async del(key) {
    await getRedisClient().del(REDIS_KEY_PREFIX + key);
  },

  async delPrefix(prefix) {
    await scanDelete(REDIS_KEY_PREFIX + prefix + "*");
  },

  async clear() {
    await scanDelete(REDIS_KEY_PREFIX + "*");
  },

  async size() {
    const client = getRedisClient();
    let cursor = "0";
    let count = 0;
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", REDIS_KEY_PREFIX + "*", "COUNT", 100);
      cursor = next;
      count += keys.length;
    } while (cursor !== "0");
    return count;
  },
};

const REGISTRY = { in_process: InProcessCacheProvider, redis: RedisCacheProvider };

function selectedProviderName() {
  const configured = (process.env.CACHE_PROVIDER || "in_process").toLowerCase();
  return REGISTRY[configured] ? configured : "in_process";
}

export function getCacheProvider() {
  return REGISTRY[selectedProviderName()];
}

export function cacheProviderStatus() {
  const entry = getCacheProvider();
  return {
    provider: entry.name,
    configured: entry.configured,
    reason: entry.configured ? null : "Requires REDIS_URL and a redis client package — not present in this environment.",
    options: Object.values(REGISTRY).map((p) => ({ id: p.name, configured: p.configured })),
  };
}

// Always the in-process Map, never REGISTRY-selected — see the file-level
// comment above. cached()/invalidate()/invalidatePrefix() use this
// deliberately so CACHE_PROVIDER=redis can never turn billing.js's
// getPlan(), featureFlags.js's isFeatureEnabled(), or maintenanceMode.js's
// maintenanceStatus() into functions that return a Promise where their
// (synchronous) callers expect a value.
function syncProvider() {
  return InProcessCacheProvider;
}

// Convenience wrapper for the common "return the cached value, or compute
// and cache it" shape every call site below uses. Permanently synchronous —
// see syncProvider() above.
export function cached(key, ttlSeconds, compute) {
  const provider = syncProvider();
  const existing = provider.get(key);
  if (existing !== undefined) return existing;
  const value = compute();
  provider.set(key, value, ttlSeconds);
  return value;
}

export function invalidate(key) {
  syncProvider().del(key);
}

export function invalidatePrefix(prefix) {
  syncProvider().delPrefix(prefix);
}

// Async counterpart of cached() for callers that are already async and can
// genuinely benefit from a shared, cross-process cache (CACHE_PROVIDER=
// redis) — routes/health.js's rollup uses this today; new Phase 18+ code
// should prefer this over cached() unless it has the same hot-path
// synchronous-caller constraint documented above. Uses the REGISTRY-selected
// provider (in-process by default, real Redis when configured), NOT
// syncProvider().
export async function cachedAsync(key, ttlSeconds, compute) {
  const provider = getCacheProvider();
  const existing = await provider.get(key);
  if (existing !== undefined) return existing;
  const value = await compute();
  await provider.set(key, value, ttlSeconds);
  return value;
}
