import { registerTool } from "../registry.js";
import { requireValidToken, getConnection } from "../../integrations/manager.js";
import * as shopify from "../../integrations/shopify/api.js";

function shopCreds(userId) {
  const token = requireValidToken(userId, "shopify");
  const conn = getConnection(userId, "shopify");
  const meta = JSON.parse(conn.meta || "{}");
  return { shop: meta.shopDomain, token };
}

registerTool({
  name: "shopify.list_orders",
  description: "Lists recent orders from the Shopify store.",
  category: "shopify",
  parameters: { type: "object", properties: { limit: { type: "number" }, status: { type: "string", description: "open, closed, cancelled, or any (default any)" } }, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const orders = await shopify.listOrders(shop, token, { limit: parameters.limit || 20, ...(parameters.status ? { status: parameters.status } : {}) });
    return { orders };
  },
});

registerTool({
  name: "shopify.get_order",
  description: "Gets full details of a specific order.",
  category: "shopify",
  parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.getOrder(shop, token, parameters.orderId);
  },
});

registerTool({
  name: "shopify.fulfill_order",
  description: "Marks an order as fulfilled, optionally with tracking info, and notifies the customer.",
  category: "shopify",
  parameters: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      trackingNumber: { type: "string" },
      trackingCompany: { type: "string" },
      notifyCustomer: { type: "boolean" },
    },
    required: ["orderId"],
  },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.createFulfillment(shop, token, parameters.orderId, parameters);
  },
});

registerTool({
  name: "shopify.cancel_order",
  description: "Cancels an order.",
  category: "shopify",
  parameters: { type: "object", properties: { orderId: { type: "string" }, reason: { type: "string" } }, required: ["orderId"] },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.cancelOrder(shop, token, parameters.orderId, parameters.reason);
  },
});

registerTool({
  name: "shopify.add_order_note",
  description: "Adds an internal note to an order.",
  category: "shopify",
  parameters: { type: "object", properties: { orderId: { type: "string" }, note: { type: "string" } }, required: ["orderId", "note"] },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.addOrderNote(shop, token, parameters.orderId, parameters.note);
  },
});
