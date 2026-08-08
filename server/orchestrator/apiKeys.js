import crypto from "crypto";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();
const ALGO = "aes-256-gcm";

function encryptionKey() {
  const secret = process.env.BYOK_ENCRYPTION_KEY;
  if (!secret) {
    const err = new Error("BYOK_ENCRYPTION_KEY is not set in server/.env — required to store customer-provided API keys securely.");
    err.code = "ENCRYPTION_NOT_CONFIGURED";
    throw err;
  }
  // Accept any passphrase length — always derive a proper 32-byte key from
  // it rather than requiring the operator to generate exact-length hex.
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(plaintext) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

function decrypt(stored) {
  const key = encryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]).toString("utf8");
}

function mask(rawKey) {
  if (rawKey.length <= 8) return "••••••••";
  return `${rawKey.slice(0, 4)}${"•".repeat(8)}${rawKey.slice(-4)}`;
}

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
