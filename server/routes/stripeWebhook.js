import { Router } from "express";
import { verifyWebhookSignature, handleWebhookEvent } from "../orchestrator/stripeService.js";

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
