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
  name: "shopify.list_collections",
  description: "Lists custom collections in the store.",
  category: "shopify",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const collections = await shopify.listCollections(shop, token);
    return { collections };
  },
});

registerTool({
  name: "shopify.create_collection",
  description: "Creates a new custom collection.",
  category: "shopify",
  parameters: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title"] },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.createCollection(shop, token, parameters);
  },
});

registerTool({
  name: "shopify.add_to_collection",
  description: "Adds a product to a collection.",
  category: "shopify",
  parameters: { type: "object", properties: { collectionId: { type: "string" }, productId: { type: "string" } }, required: ["collectionId", "productId"] },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    await shopify.addProductToCollection(shop, token, parameters.collectionId, parameters.productId);
    return { collectionId: parameters.collectionId, productId: parameters.productId, added: true };
  },
});
