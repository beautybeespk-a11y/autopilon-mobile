// Storage Provider abstraction. Nothing outside this file ever calls fs.*
// or an S3 SDK directly for file bytes — fileService.js only calls
// getStorageProvider(name).upload/download/delete/... . Adding Cloudflare
// R2, Google Cloud Storage, or another S3-compatible host later means
// pointing S3_ENDPOINT/credentials at it (R2/most others speak the S3 API);
// a genuinely different API (e.g. GCS's native client) would mean one more
// class here implementing the same shape, nothing else changes.
//
// Every provider implements:
//   upload({ key, buffer })              -> { storageKey, sizeBytes, checksum }
//   download({ key })                    -> Buffer
//   delete({ key })                      -> void
//   exists({ key })                      -> boolean
//   getMetadata({ key })                 -> { sizeBytes } | null
//   createSignedUrl({ key, expiresInSeconds }) -> string | null (null = caller must stream through the API)
//   copy({ fromKey, toKey })             -> void
//   move({ fromKey, toKey })             -> void
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = path.join(__dirname, "..", "uploads", "files");
fs.mkdirSync(LOCAL_ROOT, { recursive: true });

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Local disk storage — the default, always-available provider. Every key is
// resolved against LOCAL_ROOT and verified to still be inside it afterward,
// so a crafted key like "../../../etc/passwd" can never escape the upload
// directory (path traversal protection, required by spec section 23).
class LocalStorageProvider {
  name = "local";

  #resolve(key) {
    if (!key || typeof key !== "string") throw new Error("Invalid storage key.");
    const resolved = path.resolve(LOCAL_ROOT, key);
    if (resolved !== LOCAL_ROOT && !resolved.startsWith(LOCAL_ROOT + path.sep)) {
      throw new Error("Invalid storage key.");
    }
    return resolved;
  }

  async upload({ key, buffer }) {
    const dest = this.#resolve(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
    return { storageKey: key, sizeBytes: buffer.length, checksum: sha256(buffer) };
  }

  async download({ key }) {
    return fs.readFileSync(this.#resolve(key));
  }

  async delete({ key }) {
    const p = this.#resolve(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async exists({ key }) {
    return fs.existsSync(this.#resolve(key));
  }

  async getMetadata({ key }) {
    const p = this.#resolve(key);
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    return { sizeBytes: stat.size };
  }

  // Local disk has no authenticated-URL concept of its own — every download
  // goes through the API's own permission-checked route instead, so this
  // deliberately returns null rather than ever exposing a raw filesystem path.
  async createSignedUrl() {
    return null;
  }

  async copy({ fromKey, toKey }) {
    const src = this.#resolve(fromKey);
    const dest = this.#resolve(toKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  async move({ fromKey, toKey }) {
    const src = this.#resolve(fromKey);
    const dest = this.#resolve(toKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// S3-compatible storage — works against real AWS S3 (leave S3_ENDPOINT
// unset) or any S3-compatible host such as Cloudflare R2 / other providers
// (set S3_ENDPOINT + S3_FORCE_PATH_STYLE=true). The AWS SDK is imported
// lazily, only on first real use, exactly like firebase-admin in
// orchestrator/pushNotifications.js — this file (and the app) stays fully
// importable even when @aws-sdk/client-s3 was never configured or the
// package failed to install.
class S3StorageProvider {
  name = "s3";
  #client = null;

  #bucket() {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw Object.assign(new Error("S3_BUCKET is not set."), { code: "STORAGE_NOT_CONFIGURED" });
    return bucket;
  }

  async #getClient() {
    if (this.#client) return this.#client;
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.#client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined, // unset = real AWS S3; set = R2 or another S3-compatible host
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
    return this.#client;
  }

  async upload({ key, buffer }) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.#getClient();
    await client.send(new PutObjectCommand({ Bucket: this.#bucket(), Key: key, Body: buffer }));
    return { storageKey: key, sizeBytes: buffer.length, checksum: sha256(buffer) };
  }

  async download({ key }) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.#getClient();
    const res = await client.send(new GetObjectCommand({ Bucket: this.#bucket(), Key: key }));
    return streamToBuffer(res.Body);
  }

  async delete({ key }) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.#getClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.#bucket(), Key: key }));
  }

  async exists({ key }) {
    return Boolean(await this.getMetadata({ key }));
  }

  async getMetadata({ key }) {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.#getClient();
    try {
      const res = await client.send(new HeadObjectCommand({ Bucket: this.#bucket(), Key: key }));
      return { sizeBytes: res.ContentLength };
    } catch (err) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async createSignedUrl({ key, expiresInSeconds = 3600 }) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = await this.#getClient();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.#bucket(), Key: key }), { expiresIn: expiresInSeconds });
  }

  async copy({ fromKey, toKey }) {
    const { CopyObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.#getClient();
    await client.send(new CopyObjectCommand({ Bucket: this.#bucket(), CopySource: `${this.#bucket()}/${fromKey}`, Key: toKey }));
  }

  async move({ fromKey, toKey }) {
    await this.copy({ fromKey, toKey });
    await this.delete({ key: fromKey });
  }
}

const localProvider = new LocalStorageProvider();
let s3ProviderInstance = null;
function s3Provider() {
  if (!s3ProviderInstance) s3ProviderInstance = new S3StorageProvider();
  return s3ProviderInstance;
}

export function storageStatus() {
  const s3Configured = Boolean(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
  return {
    default: (process.env.STORAGE_PROVIDER || "local").toLowerCase(),
    providers: {
      local: { configured: true },
      s3: { configured: s3Configured, reason: s3Configured ? null : "S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are not all set" },
    },
  };
}

export function getStorageProvider(name) {
  const providerName = (name || process.env.STORAGE_PROVIDER || "local").toLowerCase();
  return providerName === "s3" ? s3Provider() : localProvider;
}
