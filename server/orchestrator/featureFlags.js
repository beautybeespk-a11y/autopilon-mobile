// Centralized Feature Flag system (Phase 16 §27) — lets a risky feature be
// disabled without a redeploy. Three layers, checked in order: an explicit
// per-user override, an explicit per-org override, then the flag's global
// enabled/rolloutPercent. An unknown flag key is always OFF — there's no
// "assume it's on" default anywhere in this file.
import db from "../db.js";
import crypto from "crypto";
import { cryptoRandom } from "../middleware.js";
import { cached, invalidate } from "./cacheProvider.js";

const now = () => new Date().toISOString();

function withOverrides(flag) {
  if (!flag) return flag;
  const overrides = db.prepare("SELECT scopeType, scopeId, enabled FROM feature_flag_overrides WHERE flagKey = ? ORDER BY createdAt ASC").all(flag.key);
  return { ...flag, enabled: Boolean(flag.enabled), overrides: overrides.map((o) => ({ ...o, enabled: Boolean(o.enabled) })) };
}

export function listFlags() {
  return db.prepare("SELECT * FROM feature_flags ORDER BY key ASC").all().map(withOverrides);
}

export function getFlag(key) {
  return withOverrides(db.prepare("SELECT * FROM feature_flags WHERE key = ?").get(key));
}

export function createFlag({ key, name, description, enabled = false, rolloutPercent = 100 }) {
  if (!key?.trim() || !name?.trim()) throw new Error("key and name are required.");
  if (db.prepare("SELECT 1 FROM feature_flags WHERE key = ?").get(key)) {
    throw Object.assign(new Error(`A flag with key "${key}" already exists.`), { code: "INVALID" });
  }
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    "INSERT INTO feature_flags (id, key, name, description, enabled, rolloutPercent, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, key.trim(), name, description || null, enabled ? 1 : 0, Math.max(0, Math.min(100, rolloutPercent)), ts, ts);
  invalidateFlagCache(key); // a prior "unknown key" evaluation may have cached a null result for this key
  return getFlag(key);
}

export function updateFlag(key, patch) {
  const flag = db.prepare("SELECT * FROM feature_flags WHERE key = ?").get(key);
  if (!flag) { const err = new Error("Feature flag not found."); err.code = "NOT_FOUND"; throw err; }
  const sets = [];
  const params = [];
  if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
  if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
  if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
  if (patch.rolloutPercent !== undefined) { sets.push("rolloutPercent = ?"); params.push(Math.max(0, Math.min(100, patch.rolloutPercent))); }
  sets.push("updatedAt = ?"); params.push(now());
  params.push(key);
  db.prepare(`UPDATE feature_flags SET ${sets.join(", ")} WHERE key = ?`).run(...params);
  invalidateFlagCache(key);
  return getFlag(key);
}

// A one-call kill switch — doesn't require the caller to know the full
// patch shape, just "turn this off right now."
export function disableFlag(key) { return updateFlag(key, { enabled: false }); }

export function deleteFlag(key) {
  db.prepare("DELETE FROM feature_flags WHERE key = ?").run(key); // feature_flag_overrides cascades via FK
  invalidateFlagCache(key);
}

export function setOverride(flagKey, scopeType, scopeId, enabled) {
  if (!["org", "user"].includes(scopeType)) throw new Error("scopeType must be 'org' or 'user'.");
  if (!db.prepare("SELECT 1 FROM feature_flags WHERE key = ?").get(flagKey)) {
    const err = new Error("Feature flag not found."); err.code = "NOT_FOUND"; throw err;
  }
  const existing = db.prepare("SELECT id FROM feature_flag_overrides WHERE flagKey = ? AND scopeType = ? AND scopeId = ?").get(flagKey, scopeType, scopeId);
  if (existing) db.prepare("UPDATE feature_flag_overrides SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, existing.id);
  else db.prepare("INSERT INTO feature_flag_overrides (id, flagKey, scopeType, scopeId, enabled, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(cryptoRandom(), flagKey, scopeType, scopeId, enabled ? 1 : 0, now());
  invalidateFlagCache(flagKey);
  return getFlag(flagKey);
}

export function removeOverride(flagKey, scopeType, scopeId) {
  db.prepare("DELETE FROM feature_flag_overrides WHERE flagKey = ? AND scopeType = ? AND scopeId = ?").run(flagKey, scopeType, scopeId);
  invalidateFlagCache(flagKey);
  return getFlag(flagKey);
}

// Deterministic hash bucketing — the SAME user/org always lands on the same
// side of a given rollout percentage for a given flag, rather than
// flapping between requests the way Math.random() would.
function inRollout(flagKey, seedId, percent) {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const hash = crypto.createHash("md5").update(`${flagKey}:${seedId}`).digest();
  return (hash.readUInt32BE(0) % 100) < percent;
}

// Evaluated on every isFeatureEnabled() call, which can sit on a hot path
// (gating behavior inside a request) — cache the flag + its full override
// list as one unit (2 queries instead of up to 3 per evaluation), not a
// per-user/org cache entry, since that would grow unbounded with distinct
// caller ids for no benefit (the override lookup against a small cached
// list is already O(1)-ish and doesn't need its own cache slot).
function evaluationData(key) {
  return cached(`flag_eval:${key}`, 30, () => {
    const flag = db.prepare("SELECT * FROM feature_flags WHERE key = ?").get(key);
    if (!flag) return { flag: null };
    const overrides = db.prepare("SELECT scopeType, scopeId, enabled FROM feature_flag_overrides WHERE flagKey = ?").all(key);
    return {
      flag,
      userOverrides: new Map(overrides.filter((o) => o.scopeType === "user").map((o) => [o.scopeId, Boolean(o.enabled)])),
      orgOverrides: new Map(overrides.filter((o) => o.scopeType === "org").map((o) => [o.scopeId, Boolean(o.enabled)])),
    };
  });
}

function invalidateFlagCache(key) {
  invalidate(`flag_eval:${key}`);
}

export function isFeatureEnabled(key, { userId, orgId } = {}) {
  const { flag, userOverrides, orgOverrides } = evaluationData(key);
  if (!flag) return false; // unknown key — never silently on

  if (userId && userOverrides.has(userId)) return userOverrides.get(userId);
  if (orgId && orgOverrides.has(orgId)) return orgOverrides.get(orgId);
  if (!flag.enabled) return false;
  const seedId = userId || orgId;
  if (!seedId) return flag.rolloutPercent >= 100; // nothing to bucket by — only a fully-on flag applies anonymously
  return inRollout(key, seedId, flag.rolloutPercent);
}
