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
  name: "shopify.list_products",
  description: "Lists products in the Shopify store.",
  category: "shopify",
  parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const products = await shopify.listProducts(shop, token, { limit: parameters.limit || 20 });
    // Shopify's raw product object already includes images[].src and a
    // handle, so nothing needs uploading anywhere to use one as an ad's
    // image (like meta.create_image_ad's imageUrl) — just add the actual
    // storefront URL, which the raw API doesn't build for you.
    return { products: products.map((p) => ({ ...p, url: `https://${shop}/products/${p.handle}` })) };
  },
});

registerTool({
  name: "shopify.get_product",
  description: "Gets full details of a specific Shopify product.",
  category: "shopify",
  parameters: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.getProduct(shop, token, parameters.productId);
  },
});

registerTool({
  name: "shopify.create_product",
  description: "Creates a new product in the Shopify store.",
  category: "shopify",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      vendor: { type: "string" },
      productType: { type: "string" },
      price: { type: "string" },
      sku: { type: "string" },
    },
    required: ["title"],
  },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const fields = {
      title: parameters.title,
      body_html: parameters.description,
      vendor: parameters.vendor,
      product_type: parameters.productType,
      variants: parameters.price ? [{ price: parameters.price, sku: parameters.sku }] : undefined,
    };
    return shopify.createProduct(shop, token, fields);
  },
});

registerTool({
  name: "shopify.update_product",
  description: "Updates fields on an existing Shopify product.",
  category: "shopify",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      productType: { type: "string" },
    },
    required: ["productId"],
  },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const { productId, description, productType, ...rest } = parameters;
    const fields = { ...rest, body_html: description, product_type: productType };
    return shopify.updateProduct(shop, token, productId, fields);
  },
});

registerTool({
  name: "shopify.delete_product",
  description: "Permanently deletes a product from the Shopify store. This cannot be undone.",
  category: "shopify",
  parameters: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    await shopify.deleteProduct(shop, token, parameters.productId);
    return { productId: parameters.productId, deleted: true };
  },
});
