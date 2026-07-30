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
  name: "shopify.get_inventory",
  description: "Gets current inventory levels for one or more inventory item IDs (found on a product variant).",
  category: "shopify",
  parameters: { type: "object", properties: { inventoryItemIds: { type: "array", items: { type: "string" } } }, required: ["inventoryItemIds"] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const levels = await shopify.getInventoryLevels(shop, token, parameters.inventoryItemIds);
    return { levels };
  },
});

registerTool({
  name: "shopify.adjust_inventory",
  description: "Adjusts (increments or decrements) the available inventory for an item at a location. Use a negative adjustment to decrease.",
  category: "shopify",
  parameters: {
    type: "object",
    properties: { inventoryItemId: { type: "string" }, locationId: { type: "string" }, adjustment: { type: "number" } },
    required: ["inventoryItemId", "locationId", "adjustment"],
  },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.adjustInventoryLevel(shop, token, parameters);
  },
});

registerTool({
  name: "shopify.list_locations",
  description: "Lists the store's inventory locations (needed for inventory tools' locationId parameter).",
  category: "shopify",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const locations = await shopify.listLocations(shop, token);
    return { locations };
  },
});
