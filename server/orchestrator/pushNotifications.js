import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();

// Lazily initialized on first actual send attempt, not at module load —
// this file is imported unconditionally (from notifications.js), so it
// must be safe to import even when no Firebase project has been set up
// yet, same as the AI provider abstraction never touches an API key until
// a request actually needs one.
let messagingApp = null;
let initAttempted = false;

export function pushStatus() {
  const configured = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  return {
    configured,
    reason: configured ? null : "FIREBASE_SERVICE_ACCOUNT_JSON is not set — see .env.example for setup steps.",
  };
}

async function getMessaging() {
  if (messagingApp) return messagingApp;
  if (initAttempted) return null; // already tried and failed this process — don't retry every call
  initAttempted = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  try {
    const admin = await import("firebase-admin");
    const serviceAccount = JSON.parse(raw);
    const app = admin.default.initializeApp({ credential: admin.default.credential.cert(serviceAccount) });
    messagingApp = admin.default.messaging(app);
    return messagingApp;
  } catch (err) {
    console.error("[push] Firebase Admin init failed — push notifications disabled for this process:", err.message);
    return null;
  }
}

export function registerDeviceToken(userId, token, platform) {
  // UPSERT on the token's uniqueness — same device re-registering (app
  // reinstall, token refresh) updates in place rather than piling up rows.
  console.log("[push] registerDeviceToken called:", { userId, platform, tokenPreview: token.slice(0, 20) + "…" });
  const existing = db.prepare("SELECT id FROM device_tokens WHERE token = ?").get(token);
  if (existing) {
    db.prepare("UPDATE device_tokens SET userId = ?, platform = ? WHERE token = ?").run(userId, platform, token);
    return existing.id;
  }
  const id = cryptoRandom();
  db.prepare("INSERT INTO device_tokens (id, userId, token, platform, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(id, userId, token, platform, now());
  return id;
}

export function unregisterDeviceToken(token) {
  db.prepare("DELETE FROM device_tokens WHERE token = ?").run(token);
}

// Best-effort, fire-and-forget from the caller's perspective (createNotification
// in notifications.js calls this without awaiting) — a push failure should
// never block or fail the in-app notification it's tied to.
export async function sendPushToUser(userId, { title, body, link }) {
  const messaging = await getMessaging();
  console.log("[push] sendPushToUser:", { userId, title, messagingReady: Boolean(messaging) });
  if (!messaging) return; // not configured — silently no-op, matches AI-provider-not-configured pattern elsewhere

  const tokens = db.prepare("SELECT token FROM device_tokens WHERE userId = ?").all(userId).map((r) => r.token);
  console.log("[push] tokens found for user:", tokens.length);
  if (!tokens.length) return;

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body: body || undefined },
      data: link ? { link } : undefined,
    });
    console.log("[push] send result:", {
      successCount: response.successCount,
      failureCount: response.failureCount,
      errors: response.responses.filter((r) => !r.success).map((r) => r.error?.message),
    });
    // Firebase reports per-token failures (expired/uninstalled) instead of
    // throwing — prune those so this user's device list doesn't accumulate
    // dead tokens forever.
    const deadTokens = response.responses
      .map((r, i) => (r.success ? null : tokens[i]))
      .filter(Boolean);
    if (deadTokens.length) {
      const placeholders = deadTokens.map(() => "?").join(",");
      db.prepare(`DELETE FROM device_tokens WHERE token IN (${placeholders})`).run(...deadTokens);
    }
  } catch (err) {
    console.error("[push] send failed:", err.message);
  }
}
