// Shopify Admin REST API client. Auth is a Custom App Admin API access
// token (Shopify Admin → Settings → Apps and sales channels → Develop apps
// → create an app → Admin API access token) — no OAuth redirect dance
// needed, same manual-token shape as the WooCommerce integration.

const API_VERSION = "2024-01";

async function shopifyFetch(shopDomain, accessToken, path, { method = "GET", body } = {}) {
  const host = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const url = `https://${host}/admin/api/${API_VERSION}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "X-Shopify-Access-Token": accessToken, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.errors ? JSON.stringify(data.errors) : `Shopify API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkStore(shopDomain, accessToken) {
  const data = await shopifyFetch(shopDomain, accessToken, "/shop.json");
  return { shopName: data.shop?.name, domain: data.shop?.domain, currency: data.shop?.currency, plan: data.shop?.plan_name };
}

// ---- Products ----
export const listProducts = (shop, token, params = {}) =>
  shopifyFetch(shop, token, `/products.json?${new URLSearchParams(params)}`).then((d) => d.products || []);
export const getProduct = (shop, token, id) => shopifyFetch(shop, token, `/products/${id}.json`).then((d) => d.product);
export const createProduct = (shop, token, fields) =>
  shopifyFetch(shop, token, "/products.json", { method: "POST", body: { product: fields } }).then((d) => d.product);
export const updateProduct = (shop, token, id, fields) =>
  shopifyFetch(shop, token, `/products/${id}.json`, { method: "PUT", body: { product: fields } }).then((d) => d.product);
export const deleteProduct = (shop, token, id) => shopifyFetch(shop, token, `/products/${id}.json`, { method: "DELETE" });

// ---- Orders ----
export const listOrders = (shop, token, params = {}) =>
  shopifyFetch(shop, token, `/orders.json?${new URLSearchParams({ status: "any", ...params })}`).then((d) => d.orders || []);
export const getOrder = (shop, token, id) => shopifyFetch(shop, token, `/orders/${id}.json`).then((d) => d.order);
export const closeOrder = (shop, token, id) => shopifyFetch(shop, token, `/orders/${id}/close.json`, { method: "POST" }).then((d) => d.order);
export const cancelOrder = (shop, token, id, reason) =>
  shopifyFetch(shop, token, `/orders/${id}/cancel.json`, { method: "POST", body: reason ? { reason } : {} }).then((d) => d.order);
export const addOrderNote = (shop, token, id, note) =>
  shopifyFetch(shop, token, `/orders/${id}.json`, { method: "PUT", body: { order: { id, note } } }).then((d) => d.order);
export const createFulfillment = (shop, token, orderId, { trackingNumber, trackingCompany, notifyCustomer = true }) =>
  shopifyFetch(shop, token, `/orders/${orderId}/fulfillments.json`, {
    method: "POST",
    body: { fulfillment: { notify_customer: notifyCustomer, tracking_info: trackingNumber ? { number: trackingNumber, company: trackingCompany } : undefined } },
  }).then((d) => d.fulfillment);

// ---- Customers ----
export const listCustomers = (shop, token, params = {}) =>
  shopifyFetch(shop, token, `/customers.json?${new URLSearchParams(params)}`).then((d) => d.customers || []);
export const getCustomer = (shop, token, id) => shopifyFetch(shop, token, `/customers/${id}.json`).then((d) => d.customer);
export const createCustomer = (shop, token, fields) =>
  shopifyFetch(shop, token, "/customers.json", { method: "POST", body: { customer: fields } }).then((d) => d.customer);
export const searchCustomers = (shop, token, query) =>
  shopifyFetch(shop, token, `/customers/search.json?${new URLSearchParams({ query })}`).then((d) => d.customers || []);

// ---- Inventory ----
export const getInventoryLevels = (shop, token, inventoryItemIds) =>
  shopifyFetch(shop, token, `/inventory_levels.json?${new URLSearchParams({ inventory_item_ids: inventoryItemIds.join(",") })}`).then(
    (d) => d.inventory_levels || []
  );
export const setInventoryLevel = (shop, token, { inventoryItemId, locationId, available }) =>
  shopifyFetch(shop, token, "/inventory_levels/set.json", {
    method: "POST",
    body: { inventory_item_id: inventoryItemId, location_id: locationId, available },
  });
export const adjustInventoryLevel = (shop, token, { inventoryItemId, locationId, adjustment }) =>
  shopifyFetch(shop, token, "/inventory_levels/adjust.json", {
    method: "POST",
    body: { inventory_item_id: inventoryItemId, location_id: locationId, available_adjustment: adjustment },
  });
export const listLocations = (shop, token) => shopifyFetch(shop, token, "/locations.json").then((d) => d.locations || []);

// ---- Discounts (price rules + discount codes — Shopify's two-step model) ----
export const createDiscount = (shop, token, { title, code, valueType = "percentage", value, startsAt, endsAt, appliesToAll = true }) =>
  shopifyFetch(shop, token, "/price_rules.json", {
    method: "POST",
    body: {
      price_rule: {
        title,
        target_type: "line_item",
        target_selection: appliesToAll ? "all" : "entitled",
        allocation_method: "across",
        value_type: valueType === "percentage" ? "percentage" : "fixed_amount",
        value: valueType === "percentage" ? `-${value}` : `-${value}`,
        customer_selection: "all",
        starts_at: startsAt || new Date().toISOString(),
        ends_at: endsAt || null,
      },
    },
  }).then(async (d) => {
    const priceRule = d.price_rule;
    const codeData = await shopifyFetch(shop, token, `/price_rules/${priceRule.id}/discount_codes.json`, {
      method: "POST",
      body: { discount_code: { code } },
    });
    return { priceRuleId: priceRule.id, code: codeData.discount_code?.code, value, valueType };
  });
export const listDiscounts = (shop, token) => shopifyFetch(shop, token, "/price_rules.json").then((d) => d.price_rules || []);
export const deleteDiscount = (shop, token, priceRuleId) => shopifyFetch(shop, token, `/price_rules/${priceRuleId}.json`, { method: "DELETE" });

// ---- Collections ----
export const listCollections = (shop, token) => shopifyFetch(shop, token, "/custom_collections.json").then((d) => d.custom_collections || []);
export const createCollection = (shop, token, { title, description }) =>
  shopifyFetch(shop, token, "/custom_collections.json", { method: "POST", body: { custom_collection: { title, body_html: description } } }).then(
    (d) => d.custom_collection
  );
export const addProductToCollection = (shop, token, collectionId, productId) =>
  shopifyFetch(shop, token, "/collects.json", { method: "POST", body: { collect: { collection_id: collectionId, product_id: productId } } });

// ---- Analytics (lightweight — real ShopifyQL analytics needs Plus; this
// aggregates from the standard orders/products endpoints, same approach
// WooCommerce's reports tools already use). ----
export async function getSalesSummary(shop, token, { sinceDays = 7 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const orders = await listOrders(shop, token, { created_at_min: since, limit: 250 });
  const totalSales = orders.reduce((sum, o) => sum + parseFloat(o.total_price || "0"), 0);
  const counts = { paid: 0, pending: 0, refunded: 0 };
  for (const o of orders) {
    if (o.financial_status === "paid") counts.paid++;
    else if (o.financial_status === "refunded" || o.financial_status === "partially_refunded") counts.refunded++;
    else counts.pending++;
  }
  return { periodDays: sinceDays, orderCount: orders.length, totalSales: totalSales.toFixed(2), byFinancialStatus: counts };
}

export async function getTopProducts(shop, token, { sinceDays = 30, limit = 5 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const orders = await listOrders(shop, token, { created_at_min: since, limit: 250 });
  const totals = new Map();
  for (const o of orders) {
    for (const item of o.line_items || []) {
      const key = item.title;
      totals.set(key, (totals.get(key) || 0) + item.quantity);
    }
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([title, quantity]) => ({ title, quantitySold: quantity }));
}

// ---- Webhooks ----
export const registerWebhook = (shop, token, { topic, address }) =>
  shopifyFetch(shop, token, "/webhooks.json", { method: "POST", body: { webhook: { topic, address, format: "json" } } }).then((d) => d.webhook);
export const listWebhooks = (shop, token) => shopifyFetch(shop, token, "/webhooks.json").then((d) => d.webhooks || []);
export const deleteWebhook = (shop, token, id) => shopifyFetch(shop, token, `/webhooks/${id}.json`, { method: "DELETE" });
