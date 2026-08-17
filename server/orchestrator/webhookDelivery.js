// The one function that actually performs an HTTP delivery to a developer's
// webhook URL — used by BOTH the synchronous test-send endpoint (Task 49)
// and the async delivery job handler (Task 50), so there is exactly one
// place that signs and sends, not two slightly-different copies.
import { assertSafeWebhookUrl } from "../publicApi/ssrf.js";
import { signWebhookPayload } from "./webhookSigning.js";

const DELIVERY_TIMEOUT_MS = 10_000;

// Returns { httpStatus, responseTimeMs, error } — error is set (and
// httpStatus is null) for anything that never got a response at all
// (SSRF-rejected, DNS failure, connection refused, timeout). A non-2xx
// HTTP response is NOT an `error` here — it's a completed delivery with a
// bad status, which the caller (job handler / test-send) decides how to
// treat (retry vs. not).
export async function deliverWebhookOnce(webhook, rawSecret, { eventType, eventId, payload }) {
  const start = Date.now();
  try {
    // Re-validated here, immediately before the actual request — never
    // trust that the URL was safe when the webhook was created. DNS can
    // change; this is the check that actually matters.
    await assertSafeWebhookUrl(webhook.url);
  } catch (err) {
    return { httpStatus: null, responseTimeMs: Date.now() - start, error: `Blocked: ${err.message}` };
  }

  const body = JSON.stringify({ id: eventId, type: eventType, createdAt: new Date().toISOString(), data: payload });
  const { header } = signWebhookPayload(rawSecret, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": header,
        "X-Webhook-Event-Id": eventId,
        "X-Webhook-Event-Type": eventType,
      },
      body,
      signal: controller.signal,
    });
    // Bounded read — a misbehaving/malicious endpoint returning gigabytes
    // must never be fully buffered into memory just to report delivery status.
    const text = (await res.text()).slice(0, 2000);
    return { httpStatus: res.status, responseTimeMs: Date.now() - start, error: null, responseBody: text };
  } catch (err) {
    const reason = err.name === "AbortError" ? "Request timed out." : err.message;
    return { httpStatus: null, responseTimeMs: Date.now() - start, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}
