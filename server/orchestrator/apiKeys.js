import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { encryptSecret as encrypt, decryptSecret as decrypt, maskSecret as mask } from "./secretsCrypto.js";

const now = () => new Date().toISOString();

export function saveApiKey(orgId, provider, rawKey) {
  const encryptedKey = encrypt(rawKey);
  const existing = db.prepare("SELECT id FROM api_keys WHERE orgId = ? AND provider = ?").get(orgId, provider);
  if (existing) {
    db.prepare("UPDATE api_keys SET encryptedKey = ?, updatedAt = ? WHERE id = ?").run(encryptedKey, now(), existing.id);
    return existing.id;
  }
  const id = cryptoRandom();
  db.prepare("INSERT INTO api_keys (id, orgId, provider, encryptedKey, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, orgId, provider, encryptedKey, now(), now());
  return id;
}

// The ONLY function that ever returns a usable key — used exclusively by
// the AI provider layer at call time, never surfaced through any API route.
export function getDecryptedApiKey(orgId, provider) {
  const row = db.prepare("SELECT encryptedKey FROM api_keys WHERE orgId = ? AND provider = ?").get(orgId, provider);
  if (!row) return null;
  return decrypt(row.encryptedKey);
}

// What routes/UI are allowed to see — provider + masked hint + timestamps,
// never the key itself.
export function listApiKeys(orgId) {
  return db.prepare("SELECT id, orgId, provider, encryptedKey, createdAt, updatedAt FROM api_keys WHERE orgId = ?").all(orgId)
    .map((r) => ({ id: r.id, orgId: r.orgId, provider: r.provider, masked: mask(decrypt(r.encryptedKey)), createdAt: r.createdAt, updatedAt: r.updatedAt }));
}

export function deleteApiKey(orgId, provider) {
  db.prepare("DELETE FROM api_keys WHERE orgId = ? AND provider = ?").run(orgId, provider);
  return { deleted: true };
}
