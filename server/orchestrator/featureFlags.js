// Centralized Feature Flag system (Phase 16 §27) — lets a risky feature be
// disabled without a redeploy. Three layers, checked in order: an explicit
// per-user override, an explicit per-org override, then the flag's global
// enabled/rolloutPercent. An unknown flag key is always OFF — there's no
// "assume it's on" default anywhere in this file.
import db from "../db.js";
import crypto from "crypto";
import { cryptoRandom } from "../middleware.js";

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
  return getFlag(key);
}

// A one-call kill switch — doesn't require the caller to know the full
// patch shape, just "turn this off right now."
export function disableFlag(key) { return updateFlag(key, { enabled: false }); }

export function deleteFlag(key) {
  db.prepare("DELETE FROM feature_flags WHERE key = ?").run(key); // feature_flag_overrides cascades via FK
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
  return getFlag(flagKey);
}

export function removeOverride(flagKey, scopeType, scopeId) {
  db.prepare("DELETE FROM feature_flag_overrides WHERE flagKey = ? AND scopeType = ? AND scopeId = ?").run(flagKey, scopeType, scopeId);
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

export function isFeatureEnabled(key, { userId, orgId } = {}) {
  const flag = db.prepare("SELECT * FROM feature_flags WHERE key = ?").get(key);
  if (!flag) return false; // unknown key — never silently on

  if (userId) {
    const userOverride = db.prepare("SELECT enabled FROM feature_flag_overrides WHERE flagKey = ? AND scopeType = 'user' AND scopeId = ?").get(key, userId);
    if (userOverride) return Boolean(userOverride.enabled);
  }
  if (orgId) {
    const orgOverride = db.prepare("SELECT enabled FROM feature_flag_overrides WHERE flagKey = ? AND scopeType = 'org' AND scopeId = ?").get(key, orgId);
    if (orgOverride) return Boolean(orgOverride.enabled);
  }
  if (!flag.enabled) return false;
  const seedId = userId || orgId;
  if (!seedId) return flag.rolloutPercent >= 100; // nothing to bucket by — only a fully-on flag applies anonymously
  return inRollout(key, seedId, flag.rolloutPercent);
}
