import { defineIntegration } from "../sdk/index.js";
import { getConnection } from "../manager.js";
import { checkStore } from "./api.js";

defineIntegration({
  id: "woocommerce",
  name: "WooCommerce",
  category: "ecommerce",
  authType: "api_key",
  requiredScopes: [],
  permissions: {
    "woocommerce.read": "View products, orders, customers, categories, and reports",
    "woocommerce.manage": "Update products/inventory, change order status, create coupons",
  },
  tools: [
    { name: "woocommerce.list_products" }, { name: "woocommerce.update_inventory" }, { name: "woocommerce.list_orders" },
    { name: "woocommerce.update_order_status" }, { name: "woocommerce.add_order_note" }, { name: "woocommerce.list_customers" },
    { name: "woocommerce.create_coupon" }, { name: "woocommerce.sales_report" },
  ],
  triggers: ["woocommerce_new_order", "woocommerce_product_out_of_stock"],
  async healthCheck(userId) {
    const conn = getConnection(userId, "woocommerce");
    if (!conn || conn.status !== "connected") return { connected: false, reason: "Not connected" };
    const meta = JSON.parse(conn.meta || "{}");
    try {
      const info = await checkStore(meta.siteUrl, meta.consumerKey, conn.accessToken);
      return { connected: true, details: info };
    } catch (err) {
      return { connected: false, reason: err.message };
    }
  },
});
