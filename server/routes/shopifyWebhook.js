import { Router } from "express";
import db from "../db.js";
import { verifyShopifyWebhook } from "../integrations/shopify/validation.js";
import { publishEvent } from "../automation/triggers.js";

const router = Router();

const TOPIC_TO_TRIGGER = {
  "orders/create": "new_shopify_order",
  "orders/paid": "shopify_order_paid",
  "orders/cancelled": "shopify_order_cancelled",
  "customers/create": "new_shopify_customer",
  "inventory_levels/update": "shopify_low_stock",
};

// Finds which platform user owns the shop a webhook came from, by matching
// the X-Shopify-Shop-Domain header against the shopDomain stored in that
// user's shopify connection meta at connect time.
function findUserByShopDomain(shopDomain) {
  const rows = db.prepare("SELECT userId, meta FROM integrations WHERE provider = 'shopify' AND status = 'connected'").all();
  for (const row of rows) {
    const meta = JSON.parse(row.meta || "{}");
    if (meta.shopDomain === shopDomain) return row.userId;
  }
  return null;
}

// Intentionally NOT behind requireAuth — Shopify calls this directly with
// no session; the HMAC signature is the authentication.
router.post("/webhook", (req, res) => {
  const hmacHeader = req.get("x-shopify-hmac-sha256");
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!verifyShopifyWebhook(req.rawBody, hmacHeader, secret)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const shopDomain = req.get("x-shopify-shop-domain");
  const topic = req.get("x-shopify-topic");
  const webhookId = req.get("x-shopify-webhook-id");
  const userId = findUserByShopDomain(shopDomain);
  if (!userId) return res.status(404).json({ error: "No connected user for this shop domain" });

  const eventType = TOPIC_TO_TRIGGER[topic];
  if (!eventType) return res.json({ ok: true, ignored: true, topic }); // topic we don't map to a trigger yet

  publishEvent(userId, "shopify", eventType, req.body || {}, webhookId || undefined);
  res.json({ ok: true });
});

export default router;
