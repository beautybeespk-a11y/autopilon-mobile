// The developer webhook dispatcher (Phase 17 §17) — the ONE place that
// turns "something happened in org X" into queued deliveries. Every call
// site that wants to notify developer webhooks calls
// publishDeveloperWebhookEvent(orgId, eventType, payload); this function
// finds the org's active, subscribed webhooks and enqueues one
// "webhook_delivery" job per webhook via the existing Job Manager — actual
// HTTP delivery, retry/backoff, and dead-lettering are the Job Manager's
// job (Phase 16), not reimplemented here.
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createJob } from "../jobs/jobManager.js";

export function publishDeveloperWebhookEvent(orgId, eventType, payload) {
  if (!orgId) return; // no org context — nothing to notify, same "unmetered/unmonitored for personal use" pattern used throughout this phase
  const webhooks = db.prepare("SELECT * FROM developer_webhooks WHERE orgId = ? AND status = 'active'").all(orgId);
  if (!webhooks.length) return;
  const eventId = `evt_${cryptoRandom()}`;
  const now = new Date().toISOString();
  for (const webhook of webhooks) {
    const events = JSON.parse(webhook.events);
    if (!events.includes("*") && !events.includes(eventType)) continue;
    const deliveryId = cryptoRandom();
    const job = createJob({
      type: "webhook_delivery", orgId,
      payload: { webhookId: webhook.id, deliveryId, eventType, eventId, payload },
    });
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhookId, jobId, eventType, eventId, payload, status, attempts, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
    ).run(deliveryId, webhook.id, job.id, eventType, eventId, JSON.stringify(payload), now);
  }
}

// Delivery history for the Developer Console / Public API (§15, §25) —
// joins the live jobs table for the authoritative current status (pending/
// running/completed/failed/dead_letter), since webhook_deliveries' own
// status column is only updated once per attempt and can be momentarily
// stale between a retry being scheduled and actually running.
export function listWebhookDeliveries(orgId, webhookId, limit = 50) {
  return db.prepare(
    `SELECT d.id, d.eventType, d.eventId, d.httpStatus, d.responseTimeMs, d.attempts, d.lastAttemptAt, d.error, d.createdAt,
            COALESCE(j.status, d.status) AS status
     FROM webhook_deliveries d
     JOIN developer_webhooks w ON w.id = d.webhookId
     LEFT JOIN jobs j ON j.id = d.jobId
     WHERE d.webhookId = ? AND w.orgId = ?
     ORDER BY d.createdAt DESC LIMIT ?`
  ).all(webhookId, orgId, Math.min(limit, 200));
}
