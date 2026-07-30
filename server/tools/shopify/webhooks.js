import { registerTool } from "../registry.js";
import { requireValidToken, getConnection } from "../../integrations/manager.js";
import * as shopify from "../../integrations/shopify/api.js";

function shopCreds(userId) {
  const token = requireValidToken(userId, "shopify");
  const conn = getConnection(userId, "shopify");
  const meta = JSON.parse(conn.meta || "{}");
  return { shop: meta.shopDomain, token };
}

// The webhook receiver route lives at /api/integrations/shopify/webhook —
// registering a webhook here just tells Shopify to start POSTing there for
// the given topic. See PHASE7_NOTES.md / shopifyWebhook.js for the topics
// this platform's automation triggers actually understand.
registerTool({
  name: "shopify.register_webhook",
  description: "Registers a Shopify webhook so events (like new orders) can trigger automations on this platform. Supported topics: orders/create, orders/paid, orders/cancelled, customers/create, inventory_levels/update.",
  category: "shopify",
  parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const base = process.env.APP_BASE_URL;
    if (!base) {
      throw new Error("APP_BASE_URL is not set in server/.env — set it to your app's public URL (e.g. your Codespace's forwarded https URL) so Shopify knows where to send webhooks.");
    }
    const address = `${base.replace(/\/$/, "")}/api/integrations/shopify/webhook`;
    return shopify.registerWebhook(shop, token, { topic: parameters.topic, address });
  },
});

registerTool({
  name: "shopify.list_webhooks",
  description: "Lists currently registered Shopify webhooks for this store.",
  category: "shopify",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const webhooks = await shopify.listWebhooks(shop, token);
    return { webhooks };
  },
});
