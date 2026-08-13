// Cache Provider abstraction (Phase 16 §41) — mirrors the exact pattern
// jobs/queueProvider.js already uses for the job backing store: a REGISTRY
// of named providers with the same method surface, so swapping the
// in-process adapter for a real distributed one (Redis) later means adding
// a new entry here, not touching any of this file's callers.
//
// Only for cheap-to-recompute, rarely-changing reads that get hit on a hot
// path (plan definitions, maintenance-mode status, feature flags) — NEVER
// for anything that must be immediately consistent across processes (usage
// counters, spend totals, quota checks) or that holds a secret. In this
// single-process deployment the in-process adapter is exact (no staleness
// beyond its own TTL); the moment this runs as more than one process, a
// real shared cache (or no cache, for correctness-sensitive reads) is
// required — that's exactly why every entry point below has a real
// TTL and a real invalidation call, not an assumption of one process.
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

// Architecture-only. No redis client is installed and no Redis instance
// exists in this environment — every method throws the same honest
// PROVIDER_NOT_CONFIGURED error the AI/Queue provider abstractions use,
// rather than silently degrading to the in-process adapter (which would
// hide that CACHE_PROVIDER=redis isn't actually sharing state across
// processes the way whoever set it would expect).
function notConfigured() {
  const err = new Error(
    "The Redis cache provider is not configured — this is architecture only. " +
    "Install the redis/ioredis package, implement this adapter's methods against a real Redis instance, and set REDIS_URL. " +
    "Until then, leave CACHE_PROVIDER unset (or 'in_process') to use the working in-process cache."
  );
  err.code = "PROVIDER_NOT_CONFIGURED";
  throw err;
}
const RedisCacheProvider = {
  name: "redis",
  configured: false,
  get: notConfigured, set: notConfigured, del: notConfigured, delPrefix: notConfigured, clear: notConfigured, size: notConfigured,
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

// Convenience wrapper for the common "return the cached value, or compute
// and cache it" shape every call site below uses.
export function cached(key, ttlSeconds, compute) {
  const provider = getCacheProvider();
  const existing = provider.get(key);
  if (existing !== undefined) return existing;
  const value = compute();
  provider.set(key, value, ttlSeconds);
  return value;
}

export function invalidate(key) {
  getCacheProvider().del(key);
}

export function invalidatePrefix(prefix) {
  getCacheProvider().delPrefix(prefix);
}
