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
  name: "shopify.sales_summary",
  description: "Summarizes recent sales: order count, total revenue, and a breakdown by payment status.",
  category: "shopify",
  parameters: { type: "object", properties: { sinceDays: { type: "number", description: "Defaults to 7" } }, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.getSalesSummary(shop, token, parameters);
  },
});

registerTool({
  name: "shopify.top_products",
  description: "Lists the best-selling products by units sold over a recent period.",
  category: "shopify",
  parameters: { type: "object", properties: { sinceDays: { type: "number", description: "Defaults to 30" }, limit: { type: "number" } }, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const topProducts = await shopify.getTopProducts(shop, token, parameters);
    return { topProducts };
  },
});
