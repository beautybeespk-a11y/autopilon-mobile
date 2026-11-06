// Meta Ads Expert V2 — Trusted Business Snapshot (Step 1).
//
// The ONE canonical, deterministic source of truth about the connected
// business + Meta account state, built fresh from LIVE data every time
// it's requested — never from chat memory (Step 13). Every fact here was
// either read directly from a real API call ("exists") or explicitly
// marked as something else — "not_connected" (a normal, expected state,
// not a failure), "fetch_failed" (the source IS connected but the call
// itself failed — genuinely different from "not connected", never
// collapsed into it), or "ambiguous" (more than one real option exists
// with no deterministic way to pick one). The strategy builder and the
// LLM must be able to tell these apart, which is why this returns
// structured status objects instead of bare booleans/nulls.
//
// Reuses the SAME underlying integration functions the rest of this app
// already uses (server/integrations/meta/api.js, woocommerce/api.js,
// shopify/api.js) and the SAME proven deterministic id resolvers
// (server/tools/shared/*) for "what's the default/resolvable asset" — this
// file adds NO new way of talking to Meta/WooCommerce/Shopify, it only
// restructures what's already fetched into the exists/not_connected/
// fetch_failed/ambiguous shape V2 needs.
import crypto from "node:crypto";
import { requireValidToken, getConnection } from "../../integrations/manager.js";
import * as meta from "../../integrations/meta/api.js";
import * as wc from "../../integrations/woocommerce/api.js";
import * as shopify from "../../integrations/shopify/api.js";
import { trace } from "./diagnostics.js";
import { findBestProductMatch, scoreAllProductsAgainstText, distinctiveTokens } from "./productMatching.js";

// Stream A — was 12, which is the SAME bug class as the 5-post cap:
// matchLinkedProduct() (below) and parseRequestedProduct()
// (creativeResolution.js) can only ever recognise a product that is in
// this list. A real store product older than the 12 most recent could
// never be linked to its own post, so the anti-fabrication match could
// never fire for it. Raised to 50: one WooCommerce/Shopify call either
// way (per_page/limit only), and a <=50-product catalogue — the large
// majority of this platform's small-business stores — is now fully
// covered. Residual gap, documented not hidden: a store with >50
// products can still have a product outside this list; for that case
// the token match in postMatchesProduct() still works when
// the name is known from the user's own words — and PR #3 (Nov 6 2026)
// adds a targeted store-search fallback in gatherBusinessSnapshot
// (searchCatalogueForProduct, below): when nothing in this sample
// matches the user's message, the store itself is asked by keyword
// before concluding "no product named". WooCommerce only — Shopify's
// REST list API has no keyword-search parameter to ask with.
const MAX_PRODUCTS = 50;
// Round 49 (live bug) — was 3, which is the SAME bug class as the
// unweighted-mean rollup below wearing a different hat: a blended figure
// computed from only 3 of a real account's campaigns is wrong in exactly
// the way that fix addresses, and it fails silently on exactly the
// accounts that matter most (a customer with more campaigns than this
// session's own test account). Raised to 25 — generous enough to fully
// cover the large majority of real small-business ad accounts in one
// snapshot call, while still bounding worst-case latency/rate-limit
// exposure (25 sequential getCampaignInsights calls, worst case) for an
// agency-scale account with hundreds of campaigns. Not a claim that 25 is
// always enough — see insightsCoverage on gatherMetaHistory's return
// value below: when the real campaign count exceeds this cap, the
// rollup says so explicitly (campaignsChecked/totalCampaigns/capped)
// rather than silently reporting a number that looks complete.
const MAX_CAMPAIGNS_FOR_INSIGHTS = 25;
const MAX_RECENT_CONTENT = 5;

// Every external call in this file goes through here — one source's
// failure never takes down the rest of the snapshot. Distinguishes a call
// that never happened because nothing is connected (the caller doesn't
// even invoke this) from one that WAS attempted and failed.
async function attempt(fn) {
  try {
    return { status: "exists", value: await fn(), reason: null };
  } catch (err) {
    return { status: "fetch_failed", value: null, reason: err.message };
  }
}

function readDefaults(conn) {
  try {
    return JSON.parse(conn?.meta || "{}").defaults || {};
  } catch {
    return {};
  }
}

// Turns a raw connected-items list + a saved default id into the
// resolution-level status the strategy builder actually needs: is there a
// deterministic answer, or genuine ambiguity? Mirrors the exact priority
// order the proven resolvers (resolveAdAccountId/resolvePageId/
// resolvePixelId/resolveCatalogId) already implement — this is a SNAPSHOT
// of what they'd conclude, for display/reasoning; assetResolution.js still
// calls the real resolvers (with a live cross-check) when actually
// resolving a strategy, never trusts this snapshot alone for that.
function resolveDefault(items, savedDefaultId) {
  const validSaved = savedDefaultId && items.some((i) => i.id === savedDefaultId) ? savedDefaultId : null;
  if (validSaved) return { resolution: "saved_default", id: validSaved };
  if (items.length === 1) return { resolution: "single_available", id: items[0].id };
  if (items.length === 0) return { resolution: "none_available", id: null };
  return { resolution: "ambiguous", id: null };
}

// Very small, deliberately conservative keyword classifier — an INFERENCE
// (Step 12), never presented as a known fact. Only used to give the
// strategy builder a starting business-type label when real product
// category data exists; the strategy's own evidence_used/reasoning_summary
// still needs to cite the REAL category names, not this label alone.
const BUSINESS_TYPE_KEYWORDS = [
  { label: "beauty/skincare", pattern: /\b(beauty|skincare|skin care|cosmetic|makeup)\b/i },
  { label: "fashion/apparel", pattern: /\b(fashion|apparel|clothing|wear|shoes|footwear)\b/i },
  { label: "electronics", pattern: /\b(electronics|gadget|phone|laptop|accessor(y|ies))\b/i },
  { label: "home/furniture", pattern: /\b(home|furniture|decor|kitchen)\b/i },
  { label: "food/grocery", pattern: /\b(food|grocery|snack|beverage)\b/i },
];
function inferBusinessType(categories) {
  const joined = (categories || []).join(" ");
  for (const { label, pattern } of BUSINESS_TYPE_KEYWORDS) {
    if (pattern.test(joined)) return label;
  }
  return null;
}

// Creative selection (Step: PRODUCT_IMAGE attach) needs a product's real
// image and link — meta.create_image_ad already requires exactly these
// (imageUrl/link), and the V1 woocommerce.list_products tool already
// surfaces them for that same reason (see its own comment). Never
// invented: null when the platform genuinely has no image/permalink for
// that product, never a guessed/constructed one for WooCommerce (a real
// site URL, but products can genuinely lack an image).
const PRODUCT_TEXT_EXCERPT_LENGTH = 300;
function stripHtmlAndTruncate(html, maxLength) {
  if (typeof html !== "string" || !html.trim()) return null;
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}…` : text;
}

async function gatherCommerce(userId) {
  const wooConn = getConnection(userId, "woocommerce");
  const shopifyConn = getConnection(userId, "shopify");
  if (!wooConn && !shopifyConn) {
    return { commerceConnected: false, commerceProvider: null, commerceDataStatus: "not_connected", storeUrl: null, storeCountry: null, businessType: null, businessTypeInferredFrom: null, productCount: null, productCategories: [], sampleProducts: [], priceRange: null, topProducts: { status: "not_connected", items: [] }, shippingGeography: null };
  }

  if (wooConn) {
    const m = JSON.parse(wooConn.meta || "{}");
    if (!m.siteUrl || !m.consumerKey) {
      return { commerceConnected: true, commerceProvider: "woocommerce", commerceDataStatus: "fetch_failed", storeUrl: m.siteUrl || null, storeCountry: null, businessType: null, businessTypeInferredFrom: null, productCount: null, productCategories: [], sampleProducts: [], priceRange: null, topProducts: { status: "fetch_failed", items: [] }, shippingGeography: null };
    }
    const accessToken = requireValidToken(userId, "woocommerce");
    // Round 48 (carousel ads) — orderby/order set explicitly rather than
    // relying on WooCommerce's own undocumented-here default (date desc,
    // confirmed against WooCommerce's own REST API docs — products are
    // already returned most-recent-first without this). Made explicit so
    // "sampleProducts is the N most recent products" — the stated,
    // deterministic rule a carousel's default 10-card proposal relies on
    // (see creativeResolution.js's resolveCarouselSelection) — is true by
    // construction in this code, not by an implicit API default this file
    // never asserted.
    const productsResult = await attempt(() => wc.listProducts(m.siteUrl, m.consumerKey, accessToken, { per_page: MAX_PRODUCTS, orderby: "date", order: "desc" }));
    const categoriesResult = await attempt(() => wc.listCategories(m.siteUrl, m.consumerKey, accessToken));
    if (productsResult.status !== "exists") {
      return { commerceConnected: true, commerceProvider: "woocommerce", commerceDataStatus: "fetch_failed", storeUrl: m.siteUrl, storeCountry: null, businessType: null, businessTypeInferredFrom: null, productCount: null, productCategories: [], sampleProducts: [], priceRange: null, topProducts: { status: "fetch_failed", items: [] }, shippingGeography: null };
    }
    const products = productsResult.value;
    const categories = (categoriesResult.value || []).map((c) => c.name);
    const sampleProducts = products.slice(0, MAX_PRODUCTS).map((p) => ({
      id: String(p.id), name: p.name, price: p.price, category: p.categories?.[0]?.name || null,
      // For PRODUCT_IMAGE creative attach (creativeResolution.js) — the
      // same real fields the V1 woocommerce.list_products tool already
      // surfaces for meta.create_image_ad's imageUrl/link. shortDescription
      // is WooCommerce's own real short_description field (HTML stripped,
      // truncated) — the ONLY source ever used for an ad's primaryText
      // without asking the user; never invented, never LLM-authored.
      imageUrl: p.images?.[0]?.src || null,
      permalink: p.permalink || null,
      shortDescription: stripHtmlAndTruncate(p.short_description, PRODUCT_TEXT_EXCERPT_LENGTH),
    }));
    const prices = sampleProducts.map((p) => Number(p.price)).filter((n) => !Number.isNaN(n));
    const countryResult = await attempt(() => wc.getStoreCountry(m.siteUrl, m.consumerKey, accessToken));
    const topSellersResult = await attempt(() => wc.getTopSellers(m.siteUrl, m.consumerKey, accessToken, "month"));
    return {
      commerceConnected: true, commerceProvider: "woocommerce", commerceDataStatus: "exists",
      storeUrl: m.siteUrl,
      storeCountry: countryResult.status === "exists" ? countryResult.value : null,
      businessType: inferBusinessType(categories),
      businessTypeInferredFrom: categories.length ? `product categories: ${categories.slice(0, 5).join(", ")}` : null,
      productCount: products.length,
      productCategories: categories,
      sampleProducts,
      priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      topProducts: topSellersResult.status === "exists"
        ? { status: "exists", items: (topSellersResult.value || []).slice(0, 5).map((t) => ({ name: t.title || t.name || null, quantity: t.total ?? t.quantity ?? null })) }
        : { status: topSellersResult.status, items: [] },
      shippingGeography: countryResult.status === "exists" && countryResult.value ? [countryResult.value] : null,
    };
  }

  // Shopify path
  const m = JSON.parse(shopifyConn.meta || "{}");
  if (!m.shopDomain) {
    return { commerceConnected: true, commerceProvider: "shopify", commerceDataStatus: "fetch_failed", storeUrl: null, storeCountry: null, businessType: null, businessTypeInferredFrom: null, productCount: null, productCategories: [], sampleProducts: [], priceRange: null, topProducts: { status: "fetch_failed", items: [] }, shippingGeography: null };
  }
  const token = requireValidToken(userId, "shopify");
  // Round 48 (carousel ads) fix — Shopify's REST Admin API default product
  // order is NOT recency (ascending by id/creation order, the opposite),
  // unlike WooCommerce's own real default above. Left implicit, "the N
  // most recent products" (the stated rule a carousel's default proposal
  // relies on) would have been silently FALSE for every Shopify store —
  // the exact goal-substitution failure mode in a new place, just found in
  // the data-fetch layer instead of a prompt. created_at desc is Shopify's
  // own real, documented sort parameter — never a client-side re-sort of
  // already-fetched data, which the per_page=limit cutoff would make
  // unreliable anyway.
  const productsResult = await attempt(() => shopify.listProducts(m.shopDomain, token, { limit: MAX_PRODUCTS, order: "created_at desc" }));
  if (productsResult.status !== "exists") {
    return { commerceConnected: true, commerceProvider: "shopify", commerceDataStatus: "fetch_failed", storeUrl: m.shopDomain, storeCountry: null, businessType: null, businessTypeInferredFrom: null, productCount: null, productCategories: [], sampleProducts: [], priceRange: null, topProducts: { status: "fetch_failed", items: [] }, shippingGeography: null };
  }
  const products = productsResult.value;
  const categories = [...new Set(products.map((p) => p.product_type).filter(Boolean))];
  // Shopify's own product object has no direct "permalink" field the way
  // WooCommerce does — this composes the real, always-reachable storefront
  // URL from the real shop domain + the real product handle (both actual
  // API fields, never guessed), the same URL shape every Shopify store
  // resolves regardless of a custom domain being layered on top.
  const sampleProducts = products.slice(0, MAX_PRODUCTS).map((p) => ({
    id: String(p.id), name: p.title, price: p.variants?.[0]?.price || null, category: p.product_type || null,
    imageUrl: p.images?.[0]?.src || null,
    permalink: p.handle ? `https://${m.shopDomain}/products/${p.handle}` : null,
    shortDescription: stripHtmlAndTruncate(p.body_html, PRODUCT_TEXT_EXCERPT_LENGTH),
  }));
  const prices = sampleProducts.map((p) => Number(p.price)).filter((n) => !Number.isNaN(n));
  const countryResult = await attempt(() => shopify.getStoreCountry(m.shopDomain, token));
  const topProductsResult = await attempt(() => shopify.getTopProducts(m.shopDomain, token, { sinceDays: 30, limit: 5 }));
  return {
    commerceConnected: true, commerceProvider: "shopify", commerceDataStatus: "exists",
    storeUrl: m.shopDomain,
    storeCountry: countryResult.status === "exists" ? countryResult.value : null,
    businessType: inferBusinessType(categories),
    businessTypeInferredFrom: categories.length ? `product categories: ${categories.slice(0, 5).join(", ")}` : null,
    productCount: products.length,
    productCategories: categories,
    sampleProducts,
    priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    topProducts: topProductsResult.status === "exists" ? { status: "exists", items: topProductsResult.value || [] } : { status: topProductsResult.status, items: [] },
    shippingGeography: countryResult.status === "exists" && countryResult.value ? [countryResult.value] : null,
  };
}

// Live bug (user-reported): a build_strategy call that omitted BOTH
// locations and countries hard-rejected with "Missing required field
// 'countries'" — real, three times, no self-correction. strategyBuilder.js's
// deriveCountriesFromLocationsIfMissing only helps when locations is
// present; this is the fallback for when it's absent too, deliberately
// separate from the full gatherBusinessSnapshot() above (which validation
// runs BEFORE fetching, precisely so a structurally-broken strategy never
// pays for a snapshot fetch it doesn't need) — a lightweight, targeted
// call to the store's own already-connected country, reusing the exact
// same wc/shopify.getStoreCountry() functions gatherCommerce() above
// already uses for the same field, so the value returned here is
// identical to what the full snapshot would eventually report. Real data
// from the store — never invented — same principle as PRODUCT_IMAGE's
// primaryText-from-shortDescription and the budget minor-unit conversion.
// Returns null (never guesses) unless exactly one real, valid-looking
// answer exists: no store connected, a fetch failure, or two connected
// stores (WooCommerce + Shopify) disagreeing on country all return null,
// deferring to the existing "Missing required field" rejection rather
// than risking the wrong country.
export async function getStoreCountryForFallback(userId) {
  const countries = new Set();
  const wooConn = getConnection(userId, "woocommerce");
  if (wooConn) {
    try {
      const m = JSON.parse(wooConn.meta || "{}");
      if (m.siteUrl && m.consumerKey) {
        const accessToken = requireValidToken(userId, "woocommerce");
        const result = await attempt(() => wc.getStoreCountry(m.siteUrl, m.consumerKey, accessToken));
        if (result.status === "exists" && result.value) countries.add(result.value);
      }
    } catch { /* best-effort fallback — a stale/invalid token here just means no answer, not a crash */ }
  }
  const shopifyConn = getConnection(userId, "shopify");
  if (shopifyConn) {
    try {
      const m = JSON.parse(shopifyConn.meta || "{}");
      if (m.shopDomain) {
        const token = requireValidToken(userId, "shopify");
        const result = await attempt(() => shopify.getStoreCountry(m.shopDomain, token));
        if (result.status === "exists" && result.value) countries.add(result.value);
      }
    } catch { /* best-effort fallback — a stale/invalid token here just means no answer, not a crash */ }
  }
  if (countries.size !== 1) return null; // none found, or two connected stores disagree — never guess
  const [code] = countries;
  return /^[A-Z]{2}$/.test(code) ? code : null; // defensively reject anything that isn't a clean ISO-2 code
}

async function gatherMetaAssets(userId, accessToken, conn) {
  const defaults = readDefaults(conn);

  const adAccountsResult = await attempt(() => meta.listAdAccounts(accessToken));
  const adAccounts = adAccountsResult.status === "exists" ? adAccountsResult.value : [];
  const adAccountDefault = resolveDefault(adAccounts, defaults.adAccountId);

  const pagesResult = await attempt(() => meta.listPages(accessToken));
  const pages = pagesResult.status === "exists" ? pagesResult.value : [];
  const pageDefault = resolveDefault(pages, defaults.pageId);

  // Pixels/catalogs are scoped to a SPECIFIC ad account — use whichever
  // one the ad-account resolution above already landed on (saved default,
  // or the single connected one) so this snapshot's Pixel/catalog facts
  // describe the SAME ad account a strategy would actually be built
  // against, never an arbitrary "first" one (the exact class of bug the
  // original planner had to fix in an earlier round — research.js used to
  // default to adAccounts[0] regardless of the saved default).
  const scopedAdAccountId = adAccountDefault.id;
  let pixels = [];
  let pixelsResult = { status: "not_connected" };
  let catalogs = [];
  let catalogsResult = { status: "not_connected" };
  if (scopedAdAccountId) {
    pixelsResult = await attempt(() => meta.listPixels(accessToken, scopedAdAccountId));
    pixels = pixelsResult.status === "exists" ? pixelsResult.value : [];
    catalogsResult = await attempt(() => meta.listCatalogs(accessToken, scopedAdAccountId));
    catalogs = catalogsResult.status === "exists" ? catalogsResult.value : [];
  }
  const pixelDefault = resolveDefault(pixels, defaults.pixelId);
  const catalogDefault = resolveDefault(catalogs, defaults.catalogId);

  // Instagram: derived from the resolved default/single Page, not scanned
  // across every connected Page — matches how a real strategy would
  // resolve it (one Page -> at most one linked Instagram Business Account).
  let instagram = null;
  let instagramStatus = "not_connected";
  if (pageDefault.id) {
    const igResult = await attempt(() => meta.getInstagramAccountId(accessToken, pageDefault.id));
    if (igResult.status === "exists" && igResult.value) {
      instagram = { accountId: igResult.value, viaPageId: pageDefault.id };
      instagramStatus = "exists";
    } else if (igResult.status === "fetch_failed") {
      instagramStatus = "fetch_failed";
    } else {
      instagramStatus = "none_available";
    }
  }
  const defaultInstagramId = defaults.instagramAccountId && instagram?.accountId === defaults.instagramAccountId ? defaults.instagramAccountId : (instagram?.accountId || null);

  // Live bug (round 30): budget_daily is a bare number with no currency
  // attached anywhere, and nothing anywhere read the REAL ad account's
  // currency from Meta at build/revise time — the model, having never
  // been told what currency the number is actually in, defaulted to "$"
  // in its own prose on a PKR account. currency was being silently
  // dropped here even though meta.listAdAccounts already returns it.
  // Exposed on both the full items list and the resolved default so
  // assetResolution.js can look it up for WHICHEVER ad account a
  // strategy actually resolves to (not necessarily the default, if the
  // user explicitly picked a different one).
  const adAccountDefaultWithCurrency = { ...adAccountDefault, currency: adAccounts.find((a) => a.id === adAccountDefault.id)?.currency || null };

  return {
    adAccounts: { status: adAccountsResult.status, items: adAccounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency || null })) },
    defaultAdAccount: adAccountDefaultWithCurrency,
    pages: { status: pagesResult.status, items: pages.map((p) => ({ id: p.id, name: p.name })) },
    defaultPage: pageDefault,
    pixels: { status: scopedAdAccountId ? pixelsResult.status : "not_connected", items: pixels.map((p) => ({ id: p.id, name: p.name })) },
    defaultPixel: pixelDefault,
    catalogs: { status: scopedAdAccountId ? catalogsResult.status : "not_connected", items: catalogs.map((c) => ({ id: c.id, name: c.name })) },
    defaultCatalog: catalogDefault,
    instagram: { status: instagramStatus, account: instagram },
    defaultInstagramId,
  };
}

// Round 49 (live bug, verified against a real Meta account): every rate
// below used to be an UNWEIGHTED MEAN of each campaign's own rate
// (avg("cpa"), avg("roas"), etc.) — mathematically wrong the moment
// spend differs between campaigns, since a rate is never the average of
// rates when the denominators differ. Two campaigns with spend 4630.24
// and 1108.56 produced a reported CPA of 844 against a real blended value
// of 638 — proof: (578.78 + 1108.56) / 2 = 843.67 (the old, wrong math)
// vs the real total spend / total purchases. Every one of these six
// fields is a rate with a per-campaign denominator that can differ
// (spend, impressions, clicks, reach), so every one of them had this same
// bug, not just the three a live account happened to expose it for.
// Fixed uniformly: sum the real numerators and denominators across every
// campaign actually examined, then divide ONCE — never average an
// already-divided number a second time. totals (below) exposes the exact
// raw sums every rate was computed from, since a rate shown with no
// visible denominator is how the original bug went unnoticed this long.
function blendedRate(numerator, denominator, multiplier = 1) {
  return denominator > 0 ? (numerator / denominator) * multiplier : null;
}

const EMPTY_METRICS = { recentSpend: null, purchases: null, cpa: null, roas: null, ctr: null, cpm: null, cpc: null, frequency: null, totals: null };

async function gatherMetaHistory(userId, accessToken, primaryAdAccountId) {
  if (!primaryAdAccountId) {
    return { status: "not_connected", campaignCount: null, activeCampaigns: null, pausedCampaigns: null, ...EMPTY_METRICS, insightsCoverage: null, bestPerformingCampaigns: { status: "not_connected", items: [] } };
  }
  // Round 49 — meta.listCampaigns now follows Meta's own paging.next
  // cursor (api.js) rather than trusting a single page always has
  // everything; this is the actual fix for "reported 8 campaigns, the
  // account has 9" — campaignCount below is only as correct as that call.
  const campaignsResult = await attempt(() => meta.listCampaigns(accessToken, primaryAdAccountId));
  if (campaignsResult.status !== "exists") {
    return { status: "fetch_failed", campaignCount: null, activeCampaigns: null, pausedCampaigns: null, ...EMPTY_METRICS, insightsCoverage: null, bestPerformingCampaigns: { status: "fetch_failed", items: [] } };
  }
  const campaigns = campaignsResult.value;
  const activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE").length;
  const pausedCampaigns = campaigns.filter((c) => c.status === "PAUSED").length;

  if (!campaigns.length) {
    return { status: "exists", campaignCount: 0, activeCampaigns: 0, pausedCampaigns: 0, ...EMPTY_METRICS, insightsCoverage: { campaignsWithInsights: 0, campaignsChecked: 0, totalCampaigns: 0, capped: false }, bestPerformingCampaigns: { status: "exists", items: [] } };
  }

  // MAX_CAMPAIGNS_FOR_INSIGHTS (see its own comment above) bounds how many
  // campaigns ever get a real getCampaignInsights call — capped is true
  // the moment the real total exceeds that bound, regardless of how many
  // of the checked campaigns actually had usable insights data back.
  const checkedCampaigns = campaigns.slice(0, MAX_CAMPAIGNS_FOR_INSIGHTS);
  const capped = campaigns.length > MAX_CAMPAIGNS_FOR_INSIGHTS;
  const withInsights = [];
  for (const c of checkedCampaigns) {
    const insightsResult = await attempt(() => meta.getCampaignInsights(accessToken, c.id));
    if (insightsResult.status === "exists" && insightsResult.value) withInsights.push({ campaignId: c.id, name: c.name, ...insightsResult.value });
  }
  const insightsCoverage = { campaignsWithInsights: withInsights.length, campaignsChecked: checkedCampaigns.length, totalCampaigns: campaigns.length, capped };
  if (!withInsights.length) {
    return { status: "exists", campaignCount: campaigns.length, activeCampaigns, pausedCampaigns, ...EMPTY_METRICS, insightsCoverage, bestPerformingCampaigns: { status: "unavailable", items: [] } };
  }

  const sum = (field) => withInsights.reduce((acc, c) => acc + (Number(c[field]) || 0), 0);
  const totalSpend = sum("spend");
  const totalClicks = sum("clicks");
  const totalImpressions = sum("impressions");
  const totalReach = sum("reach");
  const totalPurchases = sum("purchases");
  const totalRevenue = sum("revenue");
  const sorted = [...withInsights].sort((a, b) => (Number(b.roas) || 0) - (Number(a.roas) || 0));

  return {
    status: "exists",
    campaignCount: campaigns.length,
    activeCampaigns,
    pausedCampaigns,
    recentSpend: withInsights.some((c) => c.spend !== undefined) ? totalSpend : null,
    purchases: withInsights.some((c) => c.purchases !== undefined) ? totalPurchases : null,
    // Blended from totals, never averaged per-campaign rates — see this
    // function's own header comment for the live bug this replaces.
    cpa: blendedRate(totalSpend, totalPurchases),
    roas: blendedRate(totalRevenue, totalSpend),
    ctr: blendedRate(totalClicks, totalImpressions, 100),
    cpm: blendedRate(totalSpend, totalImpressions, 1000),
    cpc: blendedRate(totalSpend, totalClicks),
    frequency: blendedRate(totalImpressions, totalReach),
    // Round 49 — the raw sums every rate above was computed from. A rate
    // with no visible denominator is how the unweighted-mean bug went
    // unnoticed this long; never hide these again behind the derived
    // numbers alone.
    totals: { spend: totalSpend, clicks: totalClicks, impressions: totalImpressions, reach: totalReach, purchases: totalPurchases, revenue: totalRevenue },
    insightsCoverage,
    bestPerformingCampaigns: { status: "exists", items: sorted.slice(0, 3).map((c) => ({ campaignId: c.campaignId, name: c.name, roas: c.roas ?? null, purchases: c.purchases ?? null })) },
  };
}

const CAPTION_EXCERPT_LENGTH = 140;

// Deterministic, mechanical WooCommerce/Shopify product match — a
// TOKEN match (productMatching.js) of each product's own name against
// the post/Reel's real caption text. Never an LLM guess: if a product's
// name doesn't match the caption under the token rule, this returns no
// match rather than inferring one. Used so a creative-selection strategy
// can honestly say "this post is about product X" only when that's
// mechanically true, never invented.
// Stream A — exported (was module-private) so executor.js can recompute
// the linked product from the LIVE caption at execution time (P-A6)
// with the exact same rule, never a duplicated one.
export function matchLinkedProduct(captionText, sampleProducts) {
  if (!captionText || !Array.isArray(sampleProducts) || !sampleProducts.length) return null;
  const match = findBestProductMatch(captionText, sampleProducts);
  return match ? { name: match.name, price: match.price ?? null, category: match.category ?? null } : null;
}

// Stream A — derives WHICH product the user is talking about, from their
// own raw words, against the store's REAL catalogue only. Returns the
// product's real name, or null. Never guesses: if no real product
// matches the message under the token rule (productMatching.js), there
// is no requested product and every downstream check treats that as "no
// product constraint" rather than inventing one. Best-match-first so a
// specific product ("Maybelline Moisturizing Serum Lipstick Matte")
// beats a generic shorter product name ("Lipstick") when both are real
// catalogue entries — and so the user's own shorter wording of a
// product ("Maybelline Serum Matte Lipstick") still recognises it,
// which the old exact-full-name rule could not do (live bug, Nov 6
// 2026: the deep product search never ran for exactly that reason).
export function deriveRequestedProductFromMessage(userMessage, sampleProducts) {
  if (typeof userMessage !== "string" || !Array.isArray(sampleProducts) || !sampleProducts.length) return null;
  const match = findBestProductMatch(userMessage, sampleProducts);
  return match ? match.name : null;
}

// PR #3 (Nov 6 2026) — targeted catalogue search. sampleProducts is
// only the 50 most recent products, so a real product older than that
// can never be recognised by deriveRequestedProductFromMessage —
// investigation 2's secondary finding. When the sample matches nothing,
// ask the store itself by keyword (WooCommerce /products?search=...)
// before concluding "no product named". The search is only a
// candidate fetch: the returned products are still verified against
// the user's message under the SAME token rule (findBestProductMatch),
// so a loosely-matching search hit can never become the requested
// product on its own. Returns [] on any failure — a failed search
// degrades to exactly the old sample-only behaviour, never an error.
// Runs only when the message has >= 2 distinctive tokens (a bare
// "yes" / "3" cannot name a product) and only when the sample matched
// nothing, so the common case costs no extra call at all.
//
// Search terms are the message's distinctive tokens MINUS generic
// campaign/chat words — WooCommerce's `search` ANDs its terms, so
// "create a website purchases campaign for Maybelline Serum Matte
// Lipstick" as-is would require "create" and "website" in the
// product's own title and find nothing. Dropping those words only
// broadens the search (fewer AND terms); the token rule above is the
// precision, so a broader search can never invent a product. Pure
// numbers are dropped too — they are prices ("1250"), not name words.
const TARGETED_SEARCH_STOP_WORDS = new Set([
  "create", "campaign", "website", "purchases", "purchase", "sales", "sale",
  "ad", "ads", "facebook", "instagram", "post", "reel", "creative",
  "use", "using", "link", "budget", "day", "daily", "please", "make",
  "run", "launch", "new", "best", "top", "recent", "latest", "my", "me",
  "i", "a", "want", "need", "get", "show", "how", "did", "do", "last",
  "week", "what", "which", "when", "compare", "results", "performance",
  "spend", "much", "many",
]);
export async function searchCatalogueForProduct(userId, userMessage) {
  const wooConn = getConnection(userId, "woocommerce");
  if (!wooConn) return [];
  const m = JSON.parse(wooConn.meta || "{}");
  if (!m.siteUrl || !m.consumerKey) return [];
  const keywords = distinctiveTokens(userMessage).filter((t) => !TARGETED_SEARCH_STOP_WORDS.has(t) && !/^\d+$/.test(t));
  if (keywords.length < 2) return [];
  let accessToken;
  try {
    accessToken = requireValidToken(userId, "woocommerce");
  } catch {
    return [];
  }
  const result = await attempt(() => wc.listProducts(m.siteUrl, m.consumerKey, accessToken, { search: keywords.join(" "), per_page: 10, orderby: "date", order: "desc" }));
  if (result.status !== "exists" || !Array.isArray(result.value)) return [];
  return result.value.map((p) => ({
    id: String(p.id), name: p.name, price: p.price, category: p.categories?.[0]?.name || null,
    imageUrl: p.images?.[0]?.src || null,
    permalink: p.permalink || null,
    shortDescription: stripHtmlAndTruncate(p.short_description, PRODUCT_TEXT_EXCERPT_LENGTH),
  }));
}

// A Reel is really just an Instagram VIDEO whose permalink path says so —
// the Graph API doesn't expose a dedicated "is this a Reel" field on the
// plain media fields this snapshot fetches, so this is read off the one
// place that's actually reliable (the real permalink), never guessed from
// caption wording.
function classifyContentType(platform, mediaType, permalink) {
  if (platform === "instagram" && typeof permalink === "string" && permalink.includes("/reel/")) return "reel";
  const normalized = (mediaType || "").toLowerCase();
  if (normalized.includes("video")) return "video";
  if (normalized.includes("carousel") || normalized.includes("album")) return "carousel";
  if (normalized.includes("photo") || normalized.includes("image")) return "image";
  if (normalized === "share" || normalized === "link") return "link_share";
  return "unknown";
}

// Normalizes a raw Facebook/Instagram post into the shape strategyBuilder.js
// and the model actually need for creative selection (Step: creative-
// selection grounding) — ONLY verified facts, with every metric the
// model must never invent explicitly marked "unavailable" rather than
// omitted, so a missing fact reads as "not known," never as "zero" or
// "doesn't exist."
function normalizeContentItem(platform, raw, sampleProducts) {
  const permalink = raw.permalink_url || raw.permalink || null;
  const mediaType = platform === "facebook" ? (raw.attachments?.data?.[0]?.media_type || null) : (raw.media_type || null);
  const captionText = raw.message || raw.caption || null;
  const likes = platform === "facebook" ? raw.likes?.summary?.total_count : raw.like_count;
  const comments = platform === "facebook" ? raw.comments?.summary?.total_count : raw.comments_count;
  const shares = platform === "facebook" ? raw.shares?.count : undefined;
  const hasEngagement = [likes, comments, shares].some((v) => typeof v === "number");
  return {
    id: raw.id,
    platform,
    contentType: classifyContentType(platform, mediaType, permalink),
    captionExcerpt: captionText ? captionText.slice(0, CAPTION_EXCERPT_LENGTH) + (captionText.length > CAPTION_EXCERPT_LENGTH ? "…" : "") : null,
    // Stream A — the FULL caption text, not just the 140-char excerpt.
    // Backend matching (postMatchesProduct, creativeResolution.js) and
    // execution-time re-validation (executor.js) must match against the
    // whole caption: a product name past char 140 is still a real match,
    // and a truncated excerpt can neither prove nor disprove it. The
    // model is still SHOWN captionExcerpt (see the get_business_snapshot
    // tool description); this field is backend evidence, and the
    // recommendation text quotes captionExcerpt, never this raw field, so
    // a very long caption does not bloat what the user reads. Null when
    // the post genuinely has no caption/message — never "".
    caption: captionText || null,
    publishedDate: raw.created_time || raw.timestamp || null,
    permalink,
    mediaType,
    engagement: hasEngagement
      ? { status: "exists", likes: typeof likes === "number" ? likes : null, comments: typeof comments === "number" ? comments : null, shares: typeof shares === "number" ? shares : null }
      : { status: "unavailable", likes: null, comments: null, shares: null },
    // Not fetched in this pass — Meta's per-post reach/impressions/video-view
    // counts require a separate Insights call per post; rather than silently
    // omit the field (which the model could mistake for "doesn't exist"),
    // it's explicitly marked unavailable so the model can never claim a
    // reach/impressions/view number that was never actually retrieved.
    reachImpressions: { status: "unavailable", reach: null, impressions: null },
    videoViews: { status: "unavailable", views: null },
    linkedProduct: matchLinkedProduct(captionText, sampleProducts),
    // A fetched post/Reel with a real permalink is the same object Meta's
    // own "Boost" flow would offer — the same condition meta.boost_post
    // already relies on (a real postId/permalink to attach as an ad).
    eligibleForPromotion: Boolean(permalink),
  };
}

// Stream A — pages a platform's posts BACK from the newest until a post
// about `productName` is found, or the stated bound is hit. Shared by
// gatherRecentContent (snapshot time) and strategyBuilder.js (build time,
// when the product was named in business_goal/description or an earlier
// turn rather than in the snapshot call's own message) — one helper, one
// bound, never two implementations drifting apart. `matchFn` is
// postMatchesProduct (creativeResolution.js) applied to NORMALIZED items
// (so linkedProduct is computed on the full caption first); this helper
// does NOT re-implement matching on raw Meta rows. Returns matched
// normalized items (at most MAX_PRODUCT_SEARCH_MATCHES, newest first)
// plus honest search metadata — postsScanned/pagesFetched are what the
// not-found question quotes, never a vague "couldn't find it".
export const MAX_PRODUCT_SEARCH_MATCHES = 3;
export async function searchContentForProduct({ accessToken, pageId, instagramAccountId, platform, productName, sampleProducts }) {
  const normalizedName = (productName || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedName) return { matched: [], postsScanned: 0, pagesFetched: 0, reachedBound: false };
  // Test-stage fix (creative-source grounding): a fetch failure here must
  // NOT throw out of the caller — the strategyBuilder safety net calls
  // this outside any attempt() wrapper, so a throw escaped runBuildOrRevise
  // entirely and the revise crashed with the raw Meta error instead of
  // reaching checkCreativeSourceAvailabilityPolicy, whose whole job is to
  // reject exactly this "claims an existing post while the platform's
  // content is unusable" shape with a proper unresolved issue. Return an
  // empty result with fetchFailed:true; the section status (fetch_failed)
  // stays the authoritative signal, and the policy layer owns the
  // rejection. Callers only ever read matched/postsScanned/pagesFetched/
  // reachedBound, so the extra field is additive.
  let raw;
  const isFacebook = platform === "facebook";
  try {
    raw = isFacebook
      ? await meta.listPagePosts(accessToken, pageId, undefined, { maxPages: meta.MAX_PRODUCT_SEARCH_PAGES })
      : await meta.listInstagramPosts(accessToken, instagramAccountId, undefined, { maxPages: meta.MAX_PRODUCT_SEARCH_PAGES });
  } catch {
    return { matched: [], postsScanned: 0, pagesFetched: 0, reachedBound: false, fetchFailed: true };
  }
  // Dynamic import: businessSnapshot.js must not import
  // creativeResolution.js at module top level (creativeResolution.js
  // imports nothing from here today, but keeping the direction one-way
  // avoids ever creating a cycle if that changes). The function is
  // tiny and pure; the import cost is one module load.
  const { postMatchesProduct } = await import("./creativeResolution.js");
  // NOTE: listPagePosts/listInstagramPosts already follow paging.next
  // internally (api.js, P-A1) and return the FULL scanned set; this
  // function only filters + normalizes. Do not re-page here.
  const matched = [];
  for (const rawPost of raw.items || []) {
    const item = normalizeContentItem(platform, rawPost, sampleProducts);
    if (postMatchesProduct(item, normalizedName) && !matched.some((m) => m.id === item.id)) {
      matched.push({ ...item, foundByProductSearch: true });
      if (matched.length >= MAX_PRODUCT_SEARCH_MATCHES) break;
    }
  }
  return {
    matched,
    postsScanned: raw.totalScanned || 0,
    pagesFetched: raw.pagesFetched || 0,
    // reachedBound: true means "stopped because the bound was hit, not
    // because the history ran out" — the not-found question must say
    // which one, they are different facts.
    reachedBound: (raw.pagesFetched || 0) >= meta.MAX_PRODUCT_SEARCH_PAGES && raw.hasMore === true,
  };
}

async function gatherRecentContent(accessToken, pageId, instagram, sampleProducts, productSearchName = null) {
  // Stream A — the product search runs ONLY when a real product was
  // actually named (productSearchName non-null). Otherwise this behaves
  // exactly as before: one page, first MAX_RECENT_CONTENT items.
  // When a product WAS named: the 5 most recent are still shown first
  // (recency is still useful context), and any product-matching post
  // found deeper is APPENDED after them, marked foundByProductSearch —
  // the shown list grows past 5 rather than the match being silently
  // dropped. hasMore keeps its old meaning (more content exists beyond
  // what this fetch returned). productSearch is honest metadata for the
  // model, the policy layer, and the not-found question — never hidden.
  const facebook = pageId
    ? await attempt(async () => {
        const first = await meta.listPagePosts(accessToken, pageId);
        const items = first.items.slice(0, MAX_RECENT_CONTENT).map((p) => normalizeContentItem("facebook", p, sampleProducts));
        let productSearch = { searched: false, requestedProduct: productSearchName || null, matched: false, postsScanned: first.items.length, pagesFetched: 1, reachedBound: false };
        if (productSearchName) {
          const { postMatchesProduct } = await import("./creativeResolution.js");
          const alreadyShownMatch = items.some((i) => postMatchesProduct(i, productSearchName));
          if (!alreadyShownMatch) {
            const deep = await searchContentForProduct({ accessToken, pageId, platform: "facebook", productName: productSearchName, sampleProducts });
            const seen = new Set(items.map((i) => i.id));
            for (const m of deep.matched) {
              if (!seen.has(m.id)) { items.push(m); seen.add(m.id); }
            }
            productSearch = { searched: true, requestedProduct: productSearchName, matched: deep.matched.length > 0, postsScanned: Math.max(first.items.length, deep.postsScanned), pagesFetched: deep.pagesFetched, reachedBound: deep.reachedBound };
          } else {
            productSearch = { searched: true, requestedProduct: productSearchName, matched: true, postsScanned: first.items.length, pagesFetched: 1, reachedBound: false };
          }
        }
        return { items, hasMore: first.hasMore, productSearch };
      })
    : { status: "not_connected", value: { items: [], hasMore: false, productSearch: { searched: false, requestedProduct: productSearchName || null, matched: false, postsScanned: 0, pagesFetched: 0, reachedBound: false } }, reason: null };
  const instagramPosts = instagram?.accountId
    ? await attempt(async () => {
        const first = await meta.listInstagramPosts(accessToken, instagram.accountId);
        const items = first.items.slice(0, MAX_RECENT_CONTENT).map((p) => normalizeContentItem("instagram", p, sampleProducts));
        let productSearch = { searched: false, requestedProduct: productSearchName || null, matched: false, postsScanned: first.items.length, pagesFetched: 1, reachedBound: false };
        if (productSearchName) {
          const { postMatchesProduct } = await import("./creativeResolution.js");
          const alreadyShownMatch = items.some((i) => postMatchesProduct(i, productSearchName));
          if (!alreadyShownMatch) {
            const deep = await searchContentForProduct({ accessToken, instagramAccountId: instagram.accountId, platform: "instagram", productName: productSearchName, sampleProducts });
            const seen = new Set(items.map((i) => i.id));
            for (const m of deep.matched) {
              if (!seen.has(m.id)) { items.push(m); seen.add(m.id); }
            }
            productSearch = { searched: true, requestedProduct: productSearchName, matched: deep.matched.length > 0, postsScanned: Math.max(first.items.length, deep.postsScanned), pagesFetched: deep.pagesFetched, reachedBound: deep.reachedBound };
          } else {
            productSearch = { searched: true, requestedProduct: productSearchName, matched: true, postsScanned: first.items.length, pagesFetched: 1, reachedBound: false };
          }
        }
        return { items, hasMore: first.hasMore, productSearch };
      })
    : { status: "not_connected", value: { items: [], hasMore: false, productSearch: { searched: false, requestedProduct: productSearchName || null, matched: false, postsScanned: 0, pagesFetched: 0, reachedBound: false } }, reason: null };
  // Same friendly-reason wrapping as the meta.list_instagram_posts tool
  // (tools/meta/campaigns.js:268-270) — an IG account IS linked but the
  // read itself failed (missing OAuth scope on this deployment today), so
  // say that plainly instead of surfacing Meta's raw Graph API error text.
  // Previously this reason was captured by attempt() and then silently
  // dropped here, leaving nothing for the policy layer or the model to
  // explain to the user.
  const instagramReason = instagramPosts.status === "fetch_failed"
    ? `Instagram account is linked, but reading its posts isn't available yet (${instagramPosts.reason}). Facebook post boosting still works.`
    : instagramPosts.reason || null;
  return {
    facebookPosts: { status: facebook.status, items: facebook.value?.items || [], hasMore: facebook.value?.hasMore || false, reason: facebook.reason || null, productSearch: facebook.value?.productSearch || { searched: false, requestedProduct: productSearchName || null, matched: false, postsScanned: 0, pagesFetched: 0, reachedBound: false } },
    instagramPosts: { status: instagramPosts.status, items: instagramPosts.value?.items || [], hasMore: instagramPosts.value?.hasMore || false, reason: instagramReason, productSearch: instagramPosts.value?.productSearch || { searched: false, requestedProduct: productSearchName || null, matched: false, postsScanned: 0, pagesFetched: 0, reachedBound: false } },
  };
}

// A stable hash over the FACTS that actually matter for "is this snapshot
// still current" — deliberately excludes generatedAt itself so two
// snapshots taken seconds apart with identical underlying data hash the
// same (useful for the strategy record's snapshotVersion audit field).
function computeVersion(business, metaAssets, metaHistory) {
  const stable = {
    commerceConnected: business.commerceConnected, commerceProvider: business.commerceProvider,
    productCount: business.productCount, storeCountry: business.storeCountry,
    adAccounts: metaAssets.adAccounts.items, defaultAdAccount: metaAssets.defaultAdAccount,
    pages: metaAssets.pages.items, defaultPage: metaAssets.defaultPage,
    pixels: metaAssets.pixels.items, defaultPixel: metaAssets.defaultPixel,
    campaignCount: metaHistory.campaignCount,
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

// Live bug (round 15): build_strategy's own field description already
// warns that a generic (ALL, 18-65) audience needs audience_reasoning,
// but that text sits buried among ~30 other tool-schema fields the model
// only sees once, before it has this turn's actual data in front of it —
// and it kept getting missed even after that description was strengthened.
// Surfacing the SAME warning here instead, computed from the exact facts
// this snapshot just gathered (hasStoreData/hasCampaignHistory — the same
// signal strategyBuilder.js turns into businessSignals.
// hasStrongerAudienceEvidence right before validating), puts it in the
// freshest, most salient place: the tool result the model is reading
// immediately before it decides what to send to build_strategy. Purely
// informational — never auto-narrows anything itself, that stays the
// model's own business judgment when real data exists.
function computeAudienceEvidenceHint(hasStoreData, hasCampaignHistory) {
  if (hasStoreData || hasCampaignHistory) {
    return "Real store and/or Meta account history data exists in this snapshot — build_strategy REJECTS a generic (ALL genders, 18-65) audience left unexplained here. Use it: narrow gender/age_min/age_max from real product categories, pricing, store country, or past campaign performance, and set audience_strategy to STORE_DATA/PRODUCT_CATEGORY/ACCOUNT_HISTORY/META_PERFORMANCE accordingly. Only keep a fully generic audience if you have written a specific, defensible audience_reasoning for why this real data still doesn't justify narrowing.";
  }
  return "No connected store data or Meta campaign history exists yet — a generic (ALL genders, 18-65) audience is honest here, and build_strategy will accept it as-is even with no audience_reasoning written.";
}

// The single entry point — Step 1's "one canonical trusted snapshot from
// live connected data." Never partially cached, never backed by chat
// memory (Step 13); every call re-fetches from real APIs.
// Stream A — options.userMessage is the raw message that triggered this
// snapshot call (the get_business_snapshot tool passes
// context.userMessage; strategyBuilder passes its own userMessage). It
// is used for ONE purpose only: deriving which real product the user is
// talking about, so the recent-content fetch can search deeper than the
// 5 newest for it. It is never stored, never used for any other
// derivation, and omitting it (all pre-existing callers) simply means
// "no product search" — never a failure.
export async function gatherBusinessSnapshot(userId, { userMessage } = {}) {
  const business = await gatherCommerce(userId);

  let accessToken = null;
  let conn = null;
  try {
    accessToken = requireValidToken(userId, "meta_ads");
    conn = getConnection(userId, "meta_ads");
  } catch (err) {
    const emptyList = { status: "not_connected", items: [] };
    const emptyDefault = { resolution: "none_available", id: null };
    const snapshot = {
      generatedAt: new Date().toISOString(),
      version: null,
      business,
      metaAssets: { adAccounts: emptyList, defaultAdAccount: emptyDefault, pages: emptyList, defaultPage: emptyDefault, pixels: emptyList, defaultPixel: emptyDefault, catalogs: emptyList, defaultCatalog: emptyDefault, instagram: { status: "not_connected", account: null }, defaultInstagramId: null },
      metaHistory: { status: "not_connected", campaignCount: null, activeCampaigns: null, pausedCampaigns: null, ...EMPTY_METRICS, insightsCoverage: null, bestPerformingCampaigns: { status: "not_connected", items: [] } },
      recentContent: { facebookPosts: { status: "not_connected", items: [], reason: null }, instagramPosts: { status: "not_connected", items: [], reason: null } },
      metaConnected: false,
      metaConnectionError: err.message,
      audienceEvidenceHint: computeAudienceEvidenceHint(business.commerceConnected && business.commerceDataStatus === "exists", false),
    };
    trace("gatherBusinessSnapshot (Meta not connected)", { userId, commerceConnected: business.commerceConnected, metaError: err.message });
    return snapshot;
  }

  const metaAssets = await gatherMetaAssets(userId, accessToken, conn);
  const metaHistory = await gatherMetaHistory(userId, accessToken, metaAssets.defaultAdAccount.id);
  // Stream A — derive the requested product AFTER gatherCommerce (the
  // real catalogue is needed to recognise it) and BEFORE fetching
  // recent content (the fetch needs it to search deeper). A null here
  // just means "no product named in this message" — gatherRecentContent
  // then behaves exactly as before.
  // PR #3 — if the 50-product sample matched nothing, ask the store
  // itself by keyword before concluding no product was named. A found
  // product is APPENDED to the snapshot's sampleProducts (marked
  // foundByTargetedSearch) so every downstream layer — parseRequested-
  // Product, matchLinkedProduct, postMatchesProduct, the build-time
  // safety net — recognises it exactly like a sampled product, with no
  // second code path. The token rule still decides: a search hit that
  // doesn't match the message under that rule is ignored.
  let requestedProduct = deriveRequestedProductFromMessage(userMessage, business.sampleProducts);
  let requestedProductViaTargetedSearch = false;
  if (!requestedProduct && typeof userMessage === "string") {
    const targeted = await searchCatalogueForProduct(userId, userMessage);
    if (targeted.length) {
      const match = findBestProductMatch(userMessage, targeted);
      if (match) {
        business.sampleProducts = [...business.sampleProducts, { ...match, foundByTargetedSearch: true }];
        requestedProduct = match.name;
        requestedProductViaTargetedSearch = true;
      }
    }
  }
  const recentContent = await gatherRecentContent(accessToken, metaAssets.defaultPage.id, metaAssets.instagram.account, business.sampleProducts, requestedProduct);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    version: computeVersion(business, metaAssets, metaHistory),
    business,
    metaAssets,
    metaHistory,
    recentContent,
    metaConnected: true,
    metaConnectionError: null,
    audienceEvidenceHint: computeAudienceEvidenceHint(
      business.commerceConnected && business.commerceDataStatus === "exists",
      (metaHistory.campaignCount || 0) > 0
    ),
  };

  // Product-matching diagnosis (Nov 6 2026 fix): the old exact-name
  // rule silently returned null and the deep search never ran, with
  // nothing in the logs to show why. Log the derived product AND, when
  // it is null, the closest-scoring candidates — a future miss is
  // diagnosable from this line alone. Behind the META_EXPERT_V2_TRACE
  // flag via trace() itself; scoring <=50 products is negligible.
  const productMatchScores = typeof userMessage === "string"
    ? scoreAllProductsAgainstText(userMessage, business.sampleProducts)
    : [];
  const requestedProductScore = requestedProduct
    ? productMatchScores.find((entry) => entry.product.name === requestedProduct)?.score || null
    : null;
  trace("gatherBusinessSnapshot", {
    userId,
    version: snapshot.version,
    commerceConnected: business.commerceConnected, commerceDataStatus: business.commerceDataStatus,
    adAccountCount: metaAssets.adAccounts.items.length, defaultAdAccountResolution: metaAssets.defaultAdAccount.resolution,
    pageCount: metaAssets.pages.items.length, defaultPageResolution: metaAssets.defaultPage.resolution,
    pixelCount: metaAssets.pixels.items.length, defaultPixelResolution: metaAssets.defaultPixel.resolution,
    campaignCount: metaHistory.campaignCount,
    requestedProduct: requestedProduct || null,
    requestedProductViaTargetedSearch,
    requestedProductMatchedTokens: requestedProductScore?.matchedTokens || [],
    requestedProductMatchedCount: requestedProductScore?.matchedCount ?? 0,
    requestedProductWantedCount: requestedProductScore?.wantedCount ?? 0,
    productCandidatesConsidered: business.sampleProducts.length,
    topProductCandidates: productMatchScores.slice(0, 3).map((entry) => ({ name: entry.product.name, matched: entry.score.matchedCount, wanted: entry.score.wantedCount, required: entry.score.required })),
  });
  return snapshot;
}
