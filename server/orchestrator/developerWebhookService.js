// Developer webhook management (Phase 17 §15). Org-scoped throughout — the
// same discipline as every other Public API service this phase.
import crypto from "crypto";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { encryptSecret, decryptSecret, maskSecret } from "./secretsCrypto.js";
import { assertSafeWebhookUrl } from "../publicApi/ssrf.js";
import { deliverWebhookOnce } from "./webhookDelivery.js";

const now = () => new Date().toISOString();

// Every event type this platform can emit (Phase 17 §15) — a webhook's
// `events` array is validated against this list, same least-privilege
// principle as API key scopes: a webhook can't subscribe to something that
// doesn't exist, and "*" (all events) is explicit, not a bug in the
// filter logic.
export const WEBHOOK_EVENT_TYPES = [
  "agent.run.started", "agent.run.completed", "agent.run.failed",
  "automation.started", "automation.completed", "automation.failed",
  "task.created", "task.completed",
  "file.uploaded", "content.generated",
  "integration.connected", "integration.disconnected",
  "usage.threshold_reached",
];

function toPublicShape(row) {
  if (!row) return null;
  return {
    id: row.id, url: row.url, description: row.description, events: JSON.parse(row.events),
    status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function validateEvents(events) {
  if (!Array.isArray(events) || !events.length) { const err = new Error("events must be a non-empty array."); err.code = "INVALID"; throw err; }
  if (events.length === 1 && events[0] === "*") return;
  const unknown = events.filter((e) => !WEBHOOK_EVENT_TYPES.includes(e));
  if (unknown.length) { const err = new Error(`Unknown event type(s): ${unknown.join(", ")}`); err.code = "INVALID"; throw err; }
}

export async function createWebhook(orgId, userId, { url, description, events }) {
  if (!url?.trim()) { const err = new Error("url is required."); err.code = "INVALID"; throw err; }
  await assertSafeWebhookUrl(url);
  validateEvents(events);
  const rawSecret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO developer_webhooks (id, orgId, userId, url, description, encryptedSecret, events, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, orgId, userId, url.trim(), description || "", encryptSecret(rawSecret), JSON.stringify(events), ts, ts);
  return { ...toPublicShape(getRawWebhook(orgId, id)), secret: rawSecret };
}

function getRawWebhook(orgId, id) {
  return db.prepare("SELECT * FROM developer_webhooks WHERE id = ? AND orgId = ?").get(id, orgId);
}

export function listWebhooks(orgId) {
  return db.prepare("SELECT * FROM developer_webhooks WHERE orgId = ? ORDER BY createdAt DESC").all(orgId).map(toPublicShape);
}

export function getWebhook(orgId, id) {
  return toPublicShape(getRawWebhook(orgId, id));
}

// The signing secret persists (encrypted, not hashed — see db.js) and is
// re-viewable, unlike an API key — the developer's server needs the SAME
// secret this app already has to verify signatures, same convention
// Stripe's webhook dashboard uses ("click to reveal"), not a one-time show.
export function getWebhookSecret(orgId, id) {
  const row = getRawWebhook(orgId, id);
  if (!row) { const err = new Error("Webhook not found."); err.code = "NOT_FOUND"; throw err; }
  return { secret: decryptSecret(row.encryptedSecret), masked: maskSecret(decryptSecret(row.encryptedSecret)) };
}

export async function updateWebhook(orgId, id, patch) {
  const existing = getRawWebhook(orgId, id);
  if (!existing) { const err = new Error("Webhook not found."); err.code = "NOT_FOUND"; throw err; }
  if (patch.url !== undefined) await assertSafeWebhookUrl(patch.url);
  if (patch.events !== undefined) validateEvents(patch.events);
  const sets = [];
  const params = [];
  if (patch.url !== undefined) { sets.push("url = ?"); params.push(patch.url.trim()); }
  if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
  if (patch.events !== undefined) { sets.push("events = ?"); params.push(JSON.stringify(patch.events)); }
  if (patch.status !== undefined) {
    if (!["active", "disabled"].includes(patch.status)) { const err = new Error("status must be 'active' or 'disabled'."); err.code = "INVALID"; throw err; }
    sets.push("status = ?"); params.push(patch.status);
  }
  if (!sets.length) return toPublicShape(existing);
  sets.push("updatedAt = ?"); params.push(now());
  params.push(id, orgId);
  db.prepare(`UPDATE developer_webhooks SET ${sets.join(", ")} WHERE id = ? AND orgId = ?`).run(...params);
  return toPublicShape(getRawWebhook(orgId, id));
}

export function deleteWebhook(orgId, id) {
  const existing = getRawWebhook(orgId, id);
  if (!existing) { const err = new Error("Webhook not found."); err.code = "NOT_FOUND"; throw err; }
  db.prepare("DELETE FROM developer_webhooks WHERE id = ? AND orgId = ?").run(id, orgId); // webhook_deliveries cascades via FK
  return { deleted: true };
}

// Synchronous — a "Send test event" action is developer-initiated and
// low-volume; immediate feedback (§38: payload, signature, delivery
// result, response, latency) matters more here than queueing it like a
// real event delivery.
export async function sendTestEvent(orgId, id) {
  const webhook = getRawWebhook(orgId, id);
  if (!webhook) { const err = new Error("Webhook not found."); err.code = "NOT_FOUND"; throw err; }
  const rawSecret = decryptSecret(webhook.encryptedSecret);
  const eventId = `evt_test_${cryptoRandom()}`;
  const payload = { message: "This is a test event from the Autopilon Public API.", triggeredAt: now() };
  const result = await deliverWebhookOnce(webhook, rawSecret, { eventType: "test.ping", eventId, payload });
  return { eventId, eventType: "test.ping", payload, ...result };
}
