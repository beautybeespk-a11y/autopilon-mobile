import { defineIntegration } from "../sdk/index.js";
import { getConnection } from "../manager.js";
import { checkStore } from "./api.js";

defineIntegration({
  id: "shopify",
  name: "Shopify",
  category: "ecommerce",
  authType: "manual_token",
  requiredScopes: [],
  permissions: {
    "shopify.read": "Read products, orders, customers, inventory, and analytics",
    "shopify.manage": "Create/update products, fulfill orders, manage inventory, discounts, and collections",
  },
  tools: [
    { name: "shopify.list_products" }, { name: "shopify.get_product" }, { name: "shopify.create_product" },
    { name: "shopify.update_product" }, { name: "shopify.delete_product" },
    { name: "shopify.list_orders" }, { name: "shopify.get_order" }, { name: "shopify.fulfill_order" },
    { name: "shopify.cancel_order" }, { name: "shopify.add_order_note" },
    { name: "shopify.list_customers" }, { name: "shopify.get_customer" }, { name: "shopify.create_customer" },
    { name: "shopify.get_inventory" }, { name: "shopify.adjust_inventory" }, { name: "shopify.list_locations" },
    { name: "shopify.create_discount" }, { name: "shopify.list_discounts" }, { name: "shopify.delete_discount" },
    { name: "shopify.list_collections" }, { name: "shopify.create_collection" }, { name: "shopify.add_to_collection" },
    { name: "shopify.sales_summary" }, { name: "shopify.top_products" },
    { name: "shopify.register_webhook" }, { name: "shopify.list_webhooks" },
  ],
  triggers: ["new_shopify_order", "shopify_order_paid", "shopify_order_cancelled", "new_shopify_customer", "shopify_low_stock"],
  async healthCheck(userId) {
    const conn = getConnection(userId, "shopify");
    if (!conn || conn.status !== "connected") return { connected: false, reason: "Not connected" };
    try {
      const meta = JSON.parse(conn.meta || "{}");
      const info = await checkStore(meta.shopDomain, conn.accessToken);
      return { connected: true, details: info };
    } catch (err) {
      return { connected: false, reason: err.message };
    }
  },
});
