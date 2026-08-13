import { Router } from "express";
import { verifyWebhookSignature, handleWebhookEvent } from "../orchestrator/stripeService.js";
import { isDuplicateEvent } from "../orchestrator/webhookDedup.js";

const router = Router();

// Intentionally NOT behind requireAuth — Stripe calls this directly with no
// session; the signature (verified against req.rawBody, captured globally
// by the express.json() verify hook in index.js) is the authentication.
router.post("/webhook", async (req, res) => {
  const signature = req.get("stripe-signature");
  let event;
  try {
    event = verifyWebhookSignature(req.rawBody, signature);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }
  // Stripe explicitly documents at-least-once delivery — the same event can
  // arrive more than once. Namespaced by source since webhook_events.id is
  // one flat primary key shared with WhatsApp's dedup use of the same table.
  if (isDuplicateEvent(`stripe:${event.id}`, event.type)) {
    return res.json({ received: true, duplicate: true });
  }
  try {
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    // Stripe retries on non-2xx — respond 500 so a transient DB issue gets
    // retried automatically rather than silently losing the event.
    res.status(500).json({ error: err.message });
  }
});

export default router;
