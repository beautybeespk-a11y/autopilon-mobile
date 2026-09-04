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

const MAX_PRODUCTS = 12;
const MAX_CAMPAIGNS_FOR_INSIGHTS = 3;
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
    const productsResult = await attempt(() => wc.listProducts(m.siteUrl, m.consumerKey, accessToken, { per_page: MAX_PRODUCTS }));
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
  const productsResult = await attempt(() => shopify.listProducts(m.shopDomain, token, { limit: MAX_PRODUCTS }));
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

async function gatherMetaHistory(userId, accessToken, primaryAdAccountId) {
  if (!primaryAdAccountId) {
    return { status: "not_connected", campaignCount: null, activeCampaigns: null, pausedCampaigns: null, recentSpend: null, purchases: null, cpa: null, roas: null, ctr: null, cpm: null, cpc: null, frequency: null, bestPerformingCampaigns: { status: "not_connected", items: [] } };
  }
  const campaignsResult = await attempt(() => meta.listCampaigns(accessToken, primaryAdAccountId));
  if (campaignsResult.status !== "exists") {
    return { status: "fetch_failed", campaignCount: null, activeCampaigns: null, pausedCampaigns: null, recentSpend: null, purchases: null, cpa: null, roas: null, ctr: null, cpm: null, cpc: null, frequency: null, bestPerformingCampaigns: { status: "fetch_failed", items: [] } };
  }
  const campaigns = campaignsResult.value;
  const activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE").length;
  const pausedCampaigns = campaigns.filter((c) => c.status === "PAUSED").length;

  if (!campaigns.length) {
    return { status: "exists", campaignCount: 0, activeCampaigns: 0, pausedCampaigns: 0, recentSpend: null, purchases: null, cpa: null, roas: null, ctr: null, cpm: null, cpc: null, frequency: null, bestPerformingCampaigns: { status: "exists", items: [] } };
  }

  const withInsights = [];
  for (const c of campaigns.slice(0, MAX_CAMPAIGNS_FOR_INSIGHTS)) {
    const insightsResult = await attempt(() => meta.getCampaignInsights(accessToken, c.id));
    if (insightsResult.status === "exists" && insightsResult.value) withInsights.push({ campaignId: c.id, name: c.name, ...insightsResult.value });
  }
  if (!withInsights.length) {
    return { status: "exists", campaignCount: campaigns.length, activeCampaigns, pausedCampaigns, recentSpend: null, purchases: null, cpa: null, roas: null, ctr: null, cpm: null, cpc: null, frequency: null, bestPerformingCampaigns: { status: "unavailable", items: [] } };
  }

  const sum = (field) => withInsights.reduce((acc, c) => acc + (Number(c[field]) || 0), 0);
  const avg = (field) => {
    const vals = withInsights.map((c) => Number(c[field])).filter((n) => !Number.isNaN(n));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const sorted = [...withInsights].sort((a, b) => (Number(b.roas) || 0) - (Number(a.roas) || 0));

  return {
    status: "exists",
    campaignCount: campaigns.length,
    activeCampaigns,
    pausedCampaigns,
    recentSpend: withInsights.some((c) => c.spend !== undefined) ? sum("spend") : null,
    purchases: withInsights.some((c) => c.purchases !== undefined) ? sum("purchases") : null,
    cpa: avg("cpa"),
    roas: avg("roas"),
    ctr: avg("ctr"),
    cpm: avg("cpm"),
    cpc: avg("cpc"),
    frequency: avg("frequency"),
    bestPerformingCampaigns: { status: "exists", items: sorted.slice(0, 3).map((c) => ({ campaignId: c.campaignId, name: c.name, roas: c.roas ?? null, purchases: c.purchases ?? null })) },
  };
}

const CAPTION_EXCERPT_LENGTH = 140;

// Deterministic, mechanical WooCommerce/Shopify product match — a
// case-insensitive substring check of each product's own name against
// the post/Reel's real caption text. Never an LLM guess: if a product's
// exact name doesn't literally appear in the caption, this returns no
// match rather than inferring one. Used so a creative-selection strategy
// can honestly say "this post is about product X" only when that's
// mechanically true, never invented.
function matchLinkedProduct(captionText, sampleProducts) {
  if (!captionText || !Array.isArray(sampleProducts) || !sampleProducts.length) return null;
  const lowerCaption = captionText.toLowerCase();
  const match = sampleProducts.find((p) => p.name && lowerCaption.includes(p.name.toLowerCase()));
  return match ? { name: match.name, price: match.price ?? null, category: match.category ?? null } : null;
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

async function gatherRecentContent(accessToken, pageId, instagram, sampleProducts) {
  const facebook = pageId
    ? await attempt(async () => (await meta.listPagePosts(accessToken, pageId)).slice(0, MAX_RECENT_CONTENT).map((p) => normalizeContentItem("facebook", p, sampleProducts)))
    : { status: "not_connected", value: [], reason: null };
  const instagramPosts = instagram?.accountId
    ? await attempt(async () => (await meta.listInstagramPosts(accessToken, instagram.accountId)).slice(0, MAX_RECENT_CONTENT).map((p) => normalizeContentItem("instagram", p, sampleProducts)))
    : { status: "not_connected", value: [], reason: null };
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
    facebookPosts: { status: facebook.status, items: facebook.value || [], reason: facebook.reason || null },
    instagramPosts: { status: instagramPosts.status, items: instagramPosts.value || [], reason: instagramReason },
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
export async function gatherBusinessSnapshot(userId) {
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
      metaHistory: { status: "not_connected", campaignCount: null, activeCampaigns: null, pausedCampaigns: null, recentSpend: null, purchases: null, cpa: null, roas: null, ctr: null, cpm: null, cpc: null, frequency: null, bestPerformingCampaigns: { status: "not_connected", items: [] } },
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
  const recentContent = await gatherRecentContent(accessToken, metaAssets.defaultPage.id, metaAssets.instagram.account, business.sampleProducts);

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

  trace("gatherBusinessSnapshot", {
    userId,
    version: snapshot.version,
    commerceConnected: business.commerceConnected, commerceDataStatus: business.commerceDataStatus,
    adAccountCount: metaAssets.adAccounts.items.length, defaultAdAccountResolution: metaAssets.defaultAdAccount.resolution,
    pageCount: metaAssets.pages.items.length, defaultPageResolution: metaAssets.defaultPage.resolution,
    pixelCount: metaAssets.pixels.items.length, defaultPixelResolution: metaAssets.defaultPixel.resolution,
    campaignCount: metaHistory.campaignCount,
  });
  return snapshot;
}
