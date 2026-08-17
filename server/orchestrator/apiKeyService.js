// Developer API key management (Phase 17 §2, §3) — a distinct concept from
// orchestrator/apiKeys.js's BYOK provider keys. See db.js's
// developer_api_keys table comment for why these are hashed, not encrypted.
import crypto from "crypto";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();

// Fixed, least-privilege scope list (Phase 17 §3) — a key can only ever be
// created with scopes drawn from this set; there is no wildcard/"all
// access" scope. Grouped by resource for readability, not enforced as a
// hierarchy (agents:write does NOT imply agents:read — each is checked
// independently at the route level).
export const API_SCOPES = [
  "agents:read", "agents:execute", "agents:write",
  "automations:read", "automations:execute",
  "projects:read", "projects:write",
  "tasks:read", "tasks:write",
  "files:read", "files:write",
  "content:generate",
  "integrations:read",
  "usage:read",
  "billing:read",
  "webhooks:manage",
  "marketplace:read",
];

function generateRawKey() {
  // ap_live_<43 url-safe chars> — ~32 bytes of entropy, base64url encoded.
  // Prefixed and recognizable (same convention as sk-/pk_live_ elsewhere)
  // so a key accidentally committed to a public repo is easy to grep for
  // and revoke, and so it's visually distinct from a BYOK provider key.
  return `ap_live_${crypto.randomBytes(32).toString("base64url")}`;
}

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw Object.assign(new Error("At least one scope is required."), { code: "INVALID" });
  }
  const unknown = scopes.filter((s) => !API_SCOPES.includes(s));
  if (unknown.length) {
    throw Object.assign(new Error(`Unknown scope(s): ${unknown.join(", ")}. Valid scopes: ${API_SCOPES.join(", ")}`), { code: "INVALID" });
  }
}

function toPublicShape(row) {
  if (!row) return null;
  return {
    id: row.id, orgId: row.orgId, userId: row.userId, name: row.name,
    keyPrefix: row.keyPrefix, scopes: JSON.parse(row.scopes), status: row.status,
    expiresAt: row.expiresAt, lastUsedAt: row.lastUsedAt, createdAt: row.createdAt, revokedAt: row.revokedAt,
  };
}

// Returns { ...toPublicShape, rawKey } — rawKey is present ONLY on this
// call. Nothing else in this file, or anywhere downstream, can ever
// reconstruct it from the stored hash.
export function createApiKey(orgId, userId, { name, scopes, expiresAt } = {}) {
  if (!name?.trim()) throw Object.assign(new Error("A key name is required."), { code: "INVALID" });
  validateScopes(scopes);
  const rawKey = generateRawKey();
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO developer_api_keys (id, orgId, userId, name, keyPrefix, hashedSecret, scopes, status, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, orgId, userId, name.trim(), rawKey.slice(0, 12), hashKey(rawKey), JSON.stringify(scopes), expiresAt || null, now());
  const row = db.prepare("SELECT * FROM developer_api_keys WHERE id = ?").get(id);
  return { ...toPublicShape(row), rawKey };
}

export function listApiKeys(orgId) {
  return db.prepare("SELECT * FROM developer_api_keys WHERE orgId = ? ORDER BY createdAt DESC").all(orgId).map(toPublicShape);
}

export function getApiKey(orgId, keyId) {
  return toPublicShape(db.prepare("SELECT * FROM developer_api_keys WHERE id = ? AND orgId = ?").get(keyId, orgId));
}

export function revokeApiKey(orgId, keyId) {
  const row = db.prepare("SELECT id FROM developer_api_keys WHERE id = ? AND orgId = ?").get(keyId, orgId);
  if (!row) { const err = new Error("API key not found."); err.code = "NOT_FOUND"; throw err; }
  db.prepare("UPDATE developer_api_keys SET status = 'revoked', revokedAt = ? WHERE id = ?").run(now(), keyId);
  return getApiKey(orgId, keyId);
}

// Rotation keeps the same key row (id, name, scopes, usage history) but
// issues a brand new secret — the old secret stops working the instant
// this runs, same as revoke, but without losing the key's identity/history
// the way a full revoke-and-recreate would.
export function rotateApiKey(orgId, keyId) {
  const row = db.prepare("SELECT * FROM developer_api_keys WHERE id = ? AND orgId = ?").get(keyId, orgId);
  if (!row) { const err = new Error("API key not found."); err.code = "NOT_FOUND"; throw err; }
  if (row.status !== "active") { const err = new Error("Only an active key can be rotated."); err.code = "INVALID"; throw err; }
  const rawKey = generateRawKey();
  db.prepare("UPDATE developer_api_keys SET keyPrefix = ?, hashedSecret = ?, lastUsedAt = NULL WHERE id = ?")
    .run(rawKey.slice(0, 12), hashKey(rawKey), keyId);
  return { ...toPublicShape(getRowById(keyId)), rawKey };
}

function getRowById(keyId) {
  return db.prepare("SELECT * FROM developer_api_keys WHERE id = ?").get(keyId);
}

// The core auth lookup — one indexed hash-equality query, called on every
// public API request. Returns null for a missing, revoked, or expired key
// so the middleware can give the same generic 401 in every case (never
// distinguishing "wrong key" from "expired key" from "revoked key" in the
// response — that distinction is only visible to the org via the
// Developer Console, not to whoever is holding the invalid credential).
export function authenticateRawKey(rawKey) {
  if (!rawKey) return null;
  const row = db.prepare("SELECT * FROM developer_api_keys WHERE hashedSecret = ?").get(hashKey(rawKey));
  if (!row || row.status !== "active") return null;
  if (row.expiresAt && row.expiresAt <= now()) return null;
  db.prepare("UPDATE developer_api_keys SET lastUsedAt = ? WHERE id = ?").run(now(), row.id);
  return { id: row.id, orgId: row.orgId, userId: row.userId, name: row.name, scopes: JSON.parse(row.scopes) };
}

export function hasScope(apiKey, scope) {
  return Boolean(apiKey?.scopes?.includes(scope));
}
