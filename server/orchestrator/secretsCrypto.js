// Shared secrets-at-rest encryption — extracted from apiKeys.js (Phase 9,
// originally written for BYOK provider keys only) so Phase 17's webhook
// signing secrets can reuse the SAME encryption capability instead of a
// second one. Despite the env var's historical name, BYOK_ENCRYPTION_KEY is
// now the general "encrypt a secret this app must be able to read back"
// key — not renamed, since that would be a breaking config change for an
// existing deployment for no functional benefit.
import crypto from "crypto";

const ALGO = "aes-256-gcm";

function encryptionKey() {
  const secret = process.env.BYOK_ENCRYPTION_KEY;
  if (!secret) {
    const err = new Error("BYOK_ENCRYPTION_KEY is not set in server/.env — required to store secrets (BYOK provider keys, webhook signing secrets) securely.");
    err.code = "ENCRYPTION_NOT_CONFIGURED";
    throw err;
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored) {
  const key = encryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]).toString("utf8");
}

export function maskSecret(rawSecret) {
  if (rawSecret.length <= 8) return "••••••••";
  return `${rawSecret.slice(0, 4)}${"•".repeat(8)}${rawSecret.slice(-4)}`;
}
