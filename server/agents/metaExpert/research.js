import { requireValidToken, getConnection } from "../../integrations/manager.js";
import * as meta from "../../integrations/meta/api.js";
import * as wc from "../../integrations/woocommerce/api.js";
import * as shopify from "../../integrations/shopify/api.js";

// Bounds on every list this pulls in — this is context for an LLM prompt,
// not a full export; a handful of representative items is enough for the
// planner to reason from, and keeps this fast and cheap regardless of how
// large the real store/ad account is.
const MAX_PRODUCTS = 12;
const MAX_CAMPAIGNS_FOR_INSIGHTS = 3;
const MAX_POSTS = 5;

// One source's failure never takes down the others (Step 3: "Do not fail
// if some sources are unavailable") — every source below is wrapped the
// same way: try, and on any failure (not connected, network error, Meta
// permission gap, etc.) record a plain-language reason in `unavailable`
// and move on. Nothing here throws.
async function tryFetch(unavailable, label, fn) {
  try {
    return await fn();
  } catch (err) {
    unavailable.push(`${label}: ${err.message}`);
    return null;
  }
}

function wooCreds(userId) {
  const accessToken = requireValidToken(userId, "woocommerce"); // consumer secret, stored as the token
  const conn = getConnection(userId, "woocommerce");
  const m = JSON.parse(conn.meta || "{}");
  if (!m.siteUrl || !m.consumerKey) throw new Error("connected but missing store details");
  return { siteUrl: m.siteUrl, consumerKey: m.consumerKey, consumerSecret: accessToken };
}

function shopifyCreds(userId) {
  const token = requireValidToken(userId, "shopify");
  const conn = getConnection(userId, "shopify");
  const m = JSON.parse(conn.meta || "{}");
  if (!m.shopDomain) throw new Error("connected but missing shop domain");
  return { shop: m.shopDomain, token };
}

// Gathers what's actually known about the user's business and Meta setup
// before the planner proposes anything — Step 3. Distinguishes KNOWN facts
// (read directly from a real API) from what's simply UNAVAILABLE (source
// not connected, or the call failed) — never guesses a fact and presents
// it as known. Any INFERENCE drawn from these facts (e.g. "this looks like
// an e-commerce business") is kept in its own `inferredFacts` bucket, each
// entry stating what it was inferred FROM, so the planner (and the
// customer-facing recommendation) can tell a fact from an assumption, per
// Step 3's explicit requirement.
export async function gatherBusinessContext(userId) {
  const unavailable = [];
  const knownFacts = { commerce: null, meta: {} };
  const inferredFacts = {};

  // --- Commerce platform (WooCommerce, then Shopify) ----------------------
  const wooProducts = await tryFetch(unavailable, "WooCommerce", async () => {
    const { siteUrl, consumerKey, consumerSecret } = wooCreds(userId);
    const [products, categories] = await Promise.all([
      wc.listProducts(siteUrl, consumerKey, consumerSecret, { per_page: MAX_PRODUCTS }),
      wc.listCategories(siteUrl, consumerKey, consumerSecret),
    ]);
    return { platform: "woocommerce", products, categories };
  });

  if (wooProducts) {
    knownFacts.commerce = {
      platform: "woocommerce",
      productCount: wooProducts.products.length,
      sampleProducts: wooProducts.products.slice(0, MAX_PRODUCTS).map((p) => ({ name: p.name, price: p.price, category: p.categories?.[0]?.name || null })),
      categories: (wooProducts.categories || []).map((c) => c.name),
    };
  } else {
    const shopProducts = await tryFetch(unavailable, "Shopify", async () => {
      const { shop, token } = shopifyCreds(userId);
      return shopify.listProducts(shop, token, { limit: MAX_PRODUCTS });
    });
    if (shopProducts) {
      knownFacts.commerce = {
        platform: "shopify",
        productCount: shopProducts.length,
        sampleProducts: shopProducts.slice(0, MAX_PRODUCTS).map((p) => ({ name: p.title, price: p.variants?.[0]?.price || null, category: p.product_type || null })),
        categories: [...new Set(shopProducts.map((p) => p.product_type).filter(Boolean))],
      };
    }
  }

  if (knownFacts.commerce) {
    const prices = knownFacts.commerce.sampleProducts.map((p) => Number(p.price)).filter((n) => !Number.isNaN(n));
    if (prices.length) {
      inferredFacts.priceRange = {
        value: { min: Math.min(...prices), max: Math.max(...prices) },
        inferredFrom: `price of ${prices.length} sample products from the connected ${knownFacts.commerce.platform} store`,
      };
    }
  } else {
    unavailable.push("commerce platform: neither WooCommerce nor Shopify is connected");
  }

  // --- Meta account intelligence ------------------------------------------
  let accessToken = null;
  try {
    accessToken = requireValidToken(userId, "meta_ads");
  } catch (err) {
    unavailable.push(`Meta Ads: ${err.message}`);
    return { knownFacts, inferredFacts, unavailable };
  }

  const adAccounts = (await tryFetch(unavailable, "Meta ad accounts", () => meta.listAdAccounts(accessToken))) || [];
  knownFacts.meta.adAccounts = adAccounts;
  if (!adAccounts.length) unavailable.push("Meta ad accounts: none connected");

  const pages = (await tryFetch(unavailable, "Facebook Pages", () => meta.listPages(accessToken))) || [];
  knownFacts.meta.pages = pages;
  if (!pages.length) unavailable.push("Facebook Pages: none connected");

  // Instagram: checked against real connected Pages only, bounded, first
  // match wins — not an exhaustive audit of every Page's IG connection.
  let instagram = null;
  if (pages.length) {
    for (const page of pages.slice(0, 5)) {
      const igAccountId = await tryFetch(unavailable, `Instagram (via Page "${page.name}")`, () => meta.getInstagramAccountId(accessToken, page.id));
      if (igAccountId) { instagram = { accountId: igAccountId, viaPageId: page.id, viaPageName: page.name }; break; }
    }
  }
  knownFacts.meta.instagram = instagram;
  if (!instagram) unavailable.push("Instagram: no connected Business Account found on any connected Page");

  const primaryAdAccountId = adAccounts[0]?.id || null;
  if (primaryAdAccountId) {
    knownFacts.meta.pixels = (await tryFetch(unavailable, "Meta Pixels", () => meta.listPixels(accessToken, primaryAdAccountId))) || [];
    if (!knownFacts.meta.pixels.length) unavailable.push("Meta Pixels: none found on the primary ad account");

    knownFacts.meta.catalogs = (await tryFetch(unavailable, "Meta catalogs", () => meta.listCatalogs(accessToken, primaryAdAccountId))) || [];
    if (!knownFacts.meta.catalogs.length) unavailable.push("Meta catalogs: none found on the primary ad account");

    const campaigns = (await tryFetch(unavailable, "Existing Meta campaigns", () => meta.listCampaigns(accessToken, primaryAdAccountId))) || [];
    knownFacts.meta.existingCampaigns = campaigns;
    if (!campaigns.length) unavailable.push("Existing Meta campaigns: none found — no campaign history to learn from");

    if (campaigns.length) {
      const recentPerformance = [];
      for (const c of campaigns.slice(0, MAX_CAMPAIGNS_FOR_INSIGHTS)) {
        const insights = await tryFetch(unavailable, `Performance history for campaign "${c.name}"`, () => meta.getCampaignInsights(accessToken, c.id));
        if (insights) recentPerformance.push({ campaignId: c.id, name: c.name, ...insights });
      }
      knownFacts.meta.recentPerformance = recentPerformance;
      if (!recentPerformance.length) unavailable.push("Historical performance: campaigns exist but no insights data was available for them");
    } else {
      knownFacts.meta.recentPerformance = [];
    }
  } else {
    knownFacts.meta.pixels = [];
    knownFacts.meta.catalogs = [];
    knownFacts.meta.existingCampaigns = [];
    knownFacts.meta.recentPerformance = [];
  }

  if (pages.length) {
    const primaryPageId = pages[0].id;
    knownFacts.meta.recentPagePosts = (await tryFetch(unavailable, "Recent Facebook Page posts", async () => (await meta.listPagePosts(accessToken, primaryPageId)).slice(0, MAX_POSTS))) || [];
  } else {
    knownFacts.meta.recentPagePosts = [];
  }

  if (instagram) {
    knownFacts.meta.recentInstagramPosts = (await tryFetch(unavailable, "Recent Instagram posts", async () => (await meta.listInstagramPosts(accessToken, instagram.accountId)).slice(0, MAX_POSTS))) || [];
  } else {
    knownFacts.meta.recentInstagramPosts = [];
  }

  return { knownFacts, inferredFacts, unavailable };
}
