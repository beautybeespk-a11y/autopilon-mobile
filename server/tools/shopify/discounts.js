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
  name: "shopify.create_discount",
  description: "Creates a discount code (e.g. 10% off, or a fixed amount off) applying storewide.",
  category: "shopify",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      code: { type: "string" },
      valueType: { type: "string", description: "'percentage' or 'fixed_amount'" },
      value: { type: "number", description: "e.g. 10 for 10% off, or 5 for $5 off" },
      startsAt: { type: "string" },
      endsAt: { type: "string" },
    },
    required: ["title", "code", "value"],
  },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.createDiscount(shop, token, parameters);
  },
});

registerTool({
  name: "shopify.list_discounts",
  description: "Lists existing discount codes/price rules.",
  category: "shopify",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const discounts = await shopify.listDiscounts(shop, token);
    return { discounts };
  },
});

registerTool({
  name: "shopify.delete_discount",
  description: "Deletes a discount (price rule), deactivating its code.",
  category: "shopify",
  parameters: { type: "object", properties: { priceRuleId: { type: "string" } }, required: ["priceRuleId"] },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    await shopify.deleteDiscount(shop, token, parameters.priceRuleId);
    return { priceRuleId: parameters.priceRuleId, deleted: true };
  },
});
