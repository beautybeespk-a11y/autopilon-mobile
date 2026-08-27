// WooCommerce REST API client. Auth is a consumer key/secret pair
// (WooCommerce → Settings → Advanced → REST API → generate one).
//
// Phase 18.1 §2: over HTTPS (virtually every real store), send it as HTTP
// Basic Auth instead of `consumer_key`/`consumer_secret` query params —
// this is WooCommerce's own documented recommendation, specifically
// because a secret in the URL can end up in the store's server access
// logs, CDN logs, or a `Referer` header, none of which are under our
// control. Query params are kept only as a fallback for plain-HTTP stores
// (WooCommerce doesn't support Basic Auth without SSL).
async function wcFetch(siteUrl, consumerKey, consumerSecret, path, { method = "GET", body } = {}) {
  const url = new URL(`${siteUrl.replace(/\/$/, "")}/wp-json/wc/v3${path}`);
  const headers = { "content-type": "application/json" };
  if (url.protocol === "https:") {
    headers.authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  } else {
    url.searchParams.set("consumer_key", consumerKey);
    url.searchParams.set("consumer_secret", consumerSecret);
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `WooCommerce API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkStore(siteUrl, consumerKey, consumerSecret) {
  const data = await wcFetch(siteUrl, consumerKey, consumerSecret, "/system_status");
  return { environment: data.environment?.site_url, wcVersion: data.environment?.version };
}

// Live testing (round 4): the agent kept asking the user which cities to
// target even when the store's own delivery geography is a known,
// available fact — WooCommerce → Settings → General already has a real
// "Selling location(s)" / default country configured. woocommerce_default_
// country's value is a plain 2-letter country code, or "PK:PB"-shaped
// (country:state/region) for stores using state-level settings — only the
// country part is real Meta country-targeting can use.
export async function getStoreCountry(siteUrl, consumerKey, consumerSecret) {
  const settings = await wcFetch(siteUrl, consumerKey, consumerSecret, "/settings/general");
  const countrySetting = settings.find?.((s) => s.id === "woocommerce_default_country");
  const raw = countrySetting?.value;
  if (!raw || typeof raw !== "string") return null;
  return raw.split(":")[0] || null;
}

export const listProducts = (site, k, s, params = {}) => wcFetch(site, k, s, `/products?${new URLSearchParams(params)}`);
export const getProduct = (site, k, s, id) => wcFetch(site, k, s, `/products/${id}`);
export const createProduct = (site, k, s, fields) => wcFetch(site, k, s, "/products", { method: "POST", body: fields });
export const updateProduct = (site, k, s, id, fields) => wcFetch(site, k, s, `/products/${id}`, { method: "PUT", body: fields });
export const updateInventory = (site, k, s, id, stockQuantity) =>
  wcFetch(site, k, s, `/products/${id}`, { method: "PUT", body: { stock_quantity: stockQuantity, manage_stock: true } });

export const listOrders = (site, k, s, params = {}) => wcFetch(site, k, s, `/orders?${new URLSearchParams(params)}`);
export const getOrder = (site, k, s, id) => wcFetch(site, k, s, `/orders/${id}`);
export const updateOrderStatus = (site, k, s, id, status) => wcFetch(site, k, s, `/orders/${id}`, { method: "PUT", body: { status } });
export const addOrderNote = (site, k, s, id, note, customerNote = false) =>
  wcFetch(site, k, s, `/orders/${id}/notes`, { method: "POST", body: { note, customer_note: customerNote } });

export const listCustomers = (site, k, s, params = {}) => wcFetch(site, k, s, `/customers?${new URLSearchParams(params)}`);

export const createCoupon = (site, k, s, { code, discountType = "percent", amount, description }) =>
  wcFetch(site, k, s, "/coupons", { method: "POST", body: { code, discount_type: discountType, amount: String(amount), description } });

export const listCategories = (site, k, s) => wcFetch(site, k, s, "/products/categories?per_page=100");

export const getSalesReport = (site, k, s, period = "week") => wcFetch(site, k, s, `/reports/sales?period=${period}`);
export const getTopSellers = (site, k, s, period = "week") => wcFetch(site, k, s, `/reports/top_sellers?period=${period}`);
