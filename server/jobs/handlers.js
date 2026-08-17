// Built-in job handlers. Importing this file (once, from index.js) runs the
// registerJobHandler() calls as a side effect — same convention as
// tools/index.js registering every tool.
import db from "../db.js";
import { registerJobHandler } from "./jobManager.js";
import { executeAgentRunFromJob } from "../orchestrator/agentApiService.js";
import { decryptSecret } from "../orchestrator/secretsCrypto.js";
import { deliverWebhookOnce } from "../orchestrator/webhookDelivery.js";

// A trivial, always-succeeds job used by /health/queue to prove the queue
// is actually enqueuing AND processing, not just that the HTTP server is
// up. Includes the executing process's pid so it doubles as a real way to
// confirm which process (the API server's inline processor, or which
// worker.js instance) actually ran a given job when more than one process
// is polling the same queue (Phase 18 §8/§31).
registerJobHandler("system.selftest", async (payload, { reportProgress }) => {
  reportProgress(50, "self-test running");
  return { ok: true, echoedAt: new Date().toISOString(), pid: process.pid, payload };
});

// Async Public API agent execution (Phase 17 §7) — executeAgentRunFromJob()
// calls the exact same runAgentTurn() the synchronous /execute route uses;
// this handler exists only to let the Job Manager drive it (retry on
// failure, dead-letter after maxAttempts) instead of holding the original
// HTTP request open. The api_agent_runs row (not the job's own result
// field) is what GET /v1/runs/:id actually reads back.
registerJobHandler("public_api.agent_run", async (payload) => {
  return executeAgentRunFromJob(payload);
});

// Developer webhook delivery (Phase 17 §17) — one attempt per invocation;
// the Job Manager's own retry/backoff/dead-letter handling (Phase 16)
// drives repeated attempts, this handler just performs one and reports
// success/failure honestly via throw-vs-return. A non-2xx response or a
// network-level failure both count as "retry" (throws, retryable); a
// deleted/disabled webhook is "give up now" (retryable: false) since
// retrying can never succeed.
registerJobHandler("webhook_delivery", async (payload) => {
  const { webhookId, deliveryId, eventType, eventId, payload: eventPayload } = payload;
  const webhook = db.prepare("SELECT * FROM developer_webhooks WHERE id = ?").get(webhookId);
  const now = new Date().toISOString();

  if (!webhook || webhook.status !== "active") {
    db.prepare("UPDATE webhook_deliveries SET status = 'failed', error = ?, lastAttemptAt = ? WHERE id = ?")
      .run("Webhook was deleted or disabled.", now, deliveryId);
    const err = new Error("Webhook was deleted or disabled.");
    err.retryable = false;
    throw err;
  }

  const rawSecret = decryptSecret(webhook.encryptedSecret);
  const result = await deliverWebhookOnce(webhook, rawSecret, { eventType, eventId, payload: eventPayload });
  const current = db.prepare("SELECT attempts FROM webhook_deliveries WHERE id = ?").get(deliveryId);
  const attempts = (current?.attempts || 0) + 1;
  const success = result.httpStatus >= 200 && result.httpStatus < 300;
  // Retryable: no response at all (network/SSRF/timeout), or a 5xx/408/429
  // from the endpoint. A 4xx other than those means the developer's own
  // server is deliberately rejecting this — repeating the exact same
  // request won't change that, so it's not retried.
  const retryable = !success && (result.httpStatus == null || result.httpStatus >= 500 || result.httpStatus === 408 || result.httpStatus === 429);

  db.prepare(
    `UPDATE webhook_deliveries SET status = ?, httpStatus = ?, responseTimeMs = ?, attempts = ?, lastAttemptAt = ?, error = ? WHERE id = ?`
  ).run(
    success ? "completed" : retryable ? "retrying" : "failed",
    result.httpStatus, result.responseTimeMs, attempts, now,
    success ? null : (result.error || `Endpoint returned HTTP ${result.httpStatus}`),
    deliveryId
  );

  if (!success) {
    const err = new Error(result.error || `Endpoint returned HTTP ${result.httpStatus}`);
    err.retryable = retryable;
    throw err;
  }
  return { httpStatus: result.httpStatus, responseTimeMs: result.responseTimeMs };
});
