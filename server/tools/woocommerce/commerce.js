import { registerTool } from "../registry.js";
import { requireValidToken, getConnection } from "../../integrations/manager.js";
import * as wc from "../../integrations/woocommerce/api.js";
import { publishEvent } from "../../automation/triggers.js";

function store(userId) {
  const accessToken = requireValidToken(userId, "woocommerce"); // consumer secret, stored as the "token"
  const conn = getConnection(userId, "woocommerce");
  const meta = JSON.parse(conn.meta || "{}");
  if (!meta.siteUrl || !meta.consumerKey) {
    const err = new Error("WooCommerce is connected but missing store details. Reconnect it in Integrations.");
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  return { siteUrl: meta.siteUrl, consumerKey: meta.consumerKey, consumerSecret: accessToken };
}

registerTool({
  name: "woocommerce.list_products",
  description: "Lists products in the connected WooCommerce store, optionally filtered by stock status.",
  category: "woocommerce",
  parameters: { type: "object", properties: { search: { type: "string" }, stockStatus: { type: "string" } }, required: [] },
  requiredPermissions: ["woocommerce.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const products = await wc.listProducts(siteUrl, consumerKey, consumerSecret, {
      search: parameters.search || "", stock_status: parameters.stockStatus || "", per_page: 20,
    });
    return {
      products: products.map((p) => ({
        id: p.id, name: p.name, price: p.price, stockQuantity: p.stock_quantity, stockStatus: p.stock_status,
        // For meta.create_image_ad's imageUrl/link — a WooCommerce product's
        // own images and permalink are already public (the live store),
        // unlike a chat attachment or a Content Studio asset, so no upload
        // bridge is needed to use one directly as an ad's image/link.
        imageUrl: p.images?.[0]?.src || null,
        permalink: p.permalink || null,
      })),
    };
  },
});

registerTool({
  name: "woocommerce.create_product",
  description: "Creates a new product in the connected WooCommerce store (draft by default — set status to 'publish' to make it live immediately).",
  category: "woocommerce",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      shortDescription: { type: "string" },
      price: { type: "string" },
      sku: { type: "string" },
      status: { type: "string" },
      categoryIds: { type: "array" },
      // Must be publicly reachable — WooCommerce's own server downloads
      // each URL directly, it doesn't go through Autopilon. A link to a
      // Content Studio-generated image won't work here since those sit
      // behind login; this is for an image that's already public
      // somewhere (a stock photo URL, a public CDN link, etc).
      imageUrls: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
  },
  requiredPermissions: ["woocommerce.manage"],
  requiresConfirmation: true, // Creates a real, potentially customer-visible product — confirm first, same as wordpress.create_post.
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const fields = {
      name: parameters.title,
      description: parameters.description,
      short_description: parameters.shortDescription,
      regular_price: parameters.price,
      sku: parameters.sku,
      status: parameters.status || "draft",
    };
    if (parameters.categoryIds?.length) fields.categories = parameters.categoryIds.map((id) => ({ id }));
    if (parameters.imageUrls?.length) fields.images = parameters.imageUrls.map((src) => ({ src }));
    const product = await wc.createProduct(siteUrl, consumerKey, consumerSecret, fields);
    return { productId: product.id, name: product.name, status: product.status, permalink: product.permalink, images: product.images?.map((i) => i.src) };
  },
});

registerTool({
  name: "woocommerce.update_product",
  description: "Updates an existing WooCommerce product's title, description, price, SKU, or status. Only pass the fields you want to change.",
  category: "woocommerce",
  parameters: {
    type: "object",
    properties: {
      productId: { type: "number" },
      title: { type: "string" },
      description: { type: "string" },
      shortDescription: { type: "string" },
      price: { type: "string" },
      sku: { type: "string" },
      status: { type: "string" },
      // Same public-URL-only constraint as woocommerce.create_product —
      // replaces the product's existing image set, doesn't append to it
      // (matches WooCommerce's own REST API behavior for this field).
      imageUrls: { type: "array", items: { type: "string" } },
    },
    required: ["productId"],
  },
  requiredPermissions: ["woocommerce.manage"],
  requiresConfirmation: true, // Changes a real, potentially customer-visible product — confirm first.
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const { productId, title, description, shortDescription, price, sku, status, imageUrls } = parameters;
    const fields = {};
    if (title !== undefined) fields.name = title;
    if (description !== undefined) fields.description = description;
    if (shortDescription !== undefined) fields.short_description = shortDescription;
    if (price !== undefined) fields.regular_price = price;
    if (sku !== undefined) fields.sku = sku;
    if (status !== undefined) fields.status = status;
    if (imageUrls?.length) fields.images = imageUrls.map((src) => ({ src }));
    const product = await wc.updateProduct(siteUrl, consumerKey, consumerSecret, productId, fields);
    return { productId: product.id, name: product.name, status: product.status, permalink: product.permalink, images: product.images?.map((i) => i.src) };
  },
});

registerTool({
  name: "woocommerce.list_categories",
  description: "Lists product categories in the connected WooCommerce store — useful for finding a category's id before creating or updating a product.",
  category: "woocommerce",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["woocommerce.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const categories = await wc.listCategories(siteUrl, consumerKey, consumerSecret);
    return { categories: categories.map((c) => ({ id: c.id, name: c.name, count: c.count })) };
  },
});

registerTool({
  name: "woocommerce.update_inventory",
  description: "Updates a product's stock quantity.",
  category: "woocommerce",
  parameters: { type: "object", properties: { productId: { type: "number" }, stockQuantity: { type: "number" } }, required: ["productId", "stockQuantity"] },
  requiredPermissions: ["woocommerce.manage"],
  requiresConfirmation: true, // Changes real store inventory — confirm first.
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const product = await wc.updateInventory(siteUrl, consumerKey, consumerSecret, parameters.productId, parameters.stockQuantity);
    if (product.stock_status === "outofstock") {
      publishEvent(context.userId, "woocommerce", "woocommerce_product_out_of_stock", { productId: product.id, name: product.name });
    }
    return { productId: product.id, name: product.name, stockQuantity: product.stock_quantity, stockStatus: product.stock_status };
  },
});

registerTool({
  name: "woocommerce.list_orders",
  description: "Lists recent orders in the connected WooCommerce store.",
  category: "woocommerce",
  parameters: { type: "object", properties: { status: { type: "string" }, perPage: { type: "number" } }, required: [] },
  requiredPermissions: ["woocommerce.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const orders = await wc.listOrders(siteUrl, consumerKey, consumerSecret, { status: parameters.status || "", per_page: parameters.perPage || 20 });
    return { orders: orders.map((o) => ({ id: o.id, status: o.status, total: o.total, currency: o.currency, dateCreated: o.date_created, customer: `${o.billing?.first_name} ${o.billing?.last_name}`.trim() })) };
  },
});

registerTool({
  name: "woocommerce.update_order_status",
  description: "Updates a WooCommerce order's status (e.g. processing, completed, cancelled, refunded).",
  category: "woocommerce",
  parameters: { type: "object", properties: { orderId: { type: "number" }, status: { type: "string" } }, required: ["orderId", "status"] },
  requiredPermissions: ["woocommerce.manage"],
  requiresConfirmation: true, // Affects a real customer's order — confirm first.
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const order = await wc.updateOrderStatus(siteUrl, consumerKey, consumerSecret, parameters.orderId, parameters.status);
    return { orderId: order.id, status: order.status };
  },
});

registerTool({
  name: "woocommerce.add_order_note",
  description: "Adds a note to a WooCommerce order.",
  category: "woocommerce",
  parameters: { type: "object", properties: { orderId: { type: "number" }, note: { type: "string" }, customerNote: { type: "boolean" } }, required: ["orderId", "note"] },
  requiredPermissions: ["woocommerce.manage"],
  requiresConfirmation: true, // If customerNote is true, this emails the customer — confirm regardless, since it's cheap insurance.
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    await wc.addOrderNote(siteUrl, consumerKey, consumerSecret, parameters.orderId, parameters.note, parameters.customerNote || false);
    return { orderId: parameters.orderId, noteAdded: true };
  },
});

registerTool({
  name: "woocommerce.list_customers",
  description: "Lists customers in the connected WooCommerce store.",
  category: "woocommerce",
  parameters: { type: "object", properties: { search: { type: "string" } }, required: [] },
  requiredPermissions: ["woocommerce.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const customers = await wc.listCustomers(siteUrl, consumerKey, consumerSecret, { search: parameters.search || "" });
    return { customers: customers.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}`.trim(), email: c.email, ordersCount: c.orders_count })) };
  },
});

registerTool({
  name: "woocommerce.create_coupon",
  description: "Creates a new discount coupon.",
  category: "woocommerce",
  parameters: {
    type: "object",
    properties: { code: { type: "string" }, discountType: { type: "string" }, amount: { type: "number" }, description: { type: "string" } },
    required: ["code", "amount"],
  },
  requiredPermissions: ["woocommerce.manage"],
  requiresConfirmation: true, // Creates a real, usable discount — confirm first.
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const coupon = await wc.createCoupon(siteUrl, consumerKey, consumerSecret, parameters);
    return { couponId: coupon.id, code: coupon.code };
  },
});

registerTool({
  name: "woocommerce.sales_report",
  description: "Returns a sales summary for a period (week, month, last_month, or year).",
  category: "woocommerce",
  parameters: { type: "object", properties: { period: { type: "string" } }, required: [] },
  requiredPermissions: ["woocommerce.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { siteUrl, consumerKey, consumerSecret } = store(context.userId);
    const report = await wc.getSalesReport(siteUrl, consumerKey, consumerSecret, parameters.period || "week");
    return { report: report[0] || report };
  },
});
