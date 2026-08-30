import { logger } from "../../config/logger.js";

const API_VERSION = process.env.META_API_VERSION || "v19.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

async function metaFetch(path, { accessToken, method = "GET", body }) {
  const url = new URL(`${BASE}${path}`);
  if (method === "GET") url.searchParams.set("access_token", accessToken);
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify({ ...body, access_token: method !== "GET" ? accessToken : undefined }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiError = data?.error || {};
    // Live bug: a raw "Invalid parameter" from Meta with no further
    // context reached the customer verbatim after an execute_strategy
    // approval — Meta's generic error.message is often unhelpful on its
    // own, but the response also carries error_user_msg (Meta's own
    // human-readable explanation of WHICH parameter/why) and
    // error_subcode/fbtrace_id (needed to look the failure up with Meta
    // support). Previously only error.message was kept — everything else
    // was silently dropped, making every future occurrence just as
    // undiagnosable as this one. Logged in full for operators; the thrown
    // message includes error_user_msg when Meta provides one, since it's
    // written by Meta to be shown to the end user.
    logger.error("meta_api.request_failed", { path, method, status: res.status, code: apiError.code, errorSubcode: apiError.error_subcode, type: apiError.type, message: apiError.message, errorUserTitle: apiError.error_user_title, errorUserMsg: apiError.error_user_msg, fbtraceId: apiError.fbtrace_id });
    const message = apiError.error_user_msg || apiError.message || `Meta API error ${res.status}`;
    const err = new Error(apiError.error_subcode ? `${message} (Meta error ${apiError.code}/${apiError.error_subcode})` : message);
    err.code = apiError.code;
    err.subcode = apiError.error_subcode;
    throw err;
  }
  return data;
}

// Meta ad account IDs must be prefixed with "act_" for every API call — an
// ID given without it (e.g. copied from an account's display name, which is
// sometimes just the raw number) causes a confusing "(#100) nonexisting
// field" error rather than a clear "bad ID" one. Normalize defensively
// rather than relying on every caller (including the AI) getting it right.
function normalizeAdAccountId(id) {
  return id.startsWith("act_") ? id : `act_${id}`;
}

export async function listAdAccounts(accessToken) {
  const data = await metaFetch("/me/adaccounts?fields=id,name,account_status,currency", { accessToken });
  return data.data || [];
}

export async function listCampaigns(accessToken, adAccountId) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget`, { accessToken });
  return data.data || [];
}

export async function createCampaign(accessToken, adAccountId, { name, objective, dailyBudget, status = "PAUSED" }) {
  return metaFetch(`/${normalizeAdAccountId(adAccountId)}/campaigns`, {
    accessToken,
    method: "POST",
    body: { name, objective, status, daily_budget: dailyBudget, special_ad_categories: [] },
  });
}

export async function updateCampaign(accessToken, campaignId, fields) {
  return metaFetch(`/${campaignId}`, { accessToken, method: "POST", body: fields });
}

export async function setCampaignStatus(accessToken, campaignId, status) {
  return metaFetch(`/${campaignId}`, { accessToken, method: "POST", body: { status } });
}

// Purchases/CPA/ROAS aren't flat scalar fields in Meta's real Insights
// API — they come back as action-type breakdowns (`actions`,
// `cost_per_action_type`, `purchase_roas`, each an array of
// {action_type, value}). Meta Ads Expert V2's business snapshot (server/
// agents/metaExpertV2/businessSnapshot.js) needs these as plain numbers to
// reason about performance, so this extracts the "purchase"/"omni_purchase"
// action type's value into flat purchases/cpa/roas convenience fields
// alongside the existing flat fields (impressions/clicks/spend/ctr/cpc/
// reach) and the new cpm/frequency — purely additive; every existing
// caller that only reads the original fields is unaffected, and the raw
// actions/cost_per_action_type/purchase_roas arrays are still returned too
// for anyone who wants the full breakdown.
const PURCHASE_ACTION_TYPES = new Set(["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);
function extractActionValue(actionsArray) {
  if (!Array.isArray(actionsArray)) return null;
  const match = actionsArray.find((a) => PURCHASE_ACTION_TYPES.has(a.action_type));
  return match ? Number(match.value) : null;
}
export async function getCampaignInsights(accessToken, campaignId, datePreset = "last_30d") {
  const data = await metaFetch(
    `/${campaignId}/insights?fields=impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type,purchase_roas&date_preset=${datePreset}`,
    { accessToken }
  );
  const row = data.data?.[0];
  if (!row) return null;
  return {
    ...row,
    purchases: extractActionValue(row.actions),
    cpa: extractActionValue(row.cost_per_action_type),
    roas: Array.isArray(row.purchase_roas) && row.purchase_roas[0] ? Number(row.purchase_roas[0].value) : null,
  };
}

// Needed to pick which Facebook Page an ad creative posts as
// (object_story_spec.page_id below) — requires the pages_show_list scope.
//
// /me/accounts ONLY returns Pages where the user has a classic, direct
// per-Page role — confirmed live: a real account with 3 real Pages, all
// managed through a Business Portfolio (Business Manager) with only
// portfolio-level "Full access" assigned rather than a classic Page role,
// got an empty result here every time despite being a genuine Page admin
// through Business Settings. This is a known, common gap for any business
// using Meta's newer Business Portfolio structure, not an edge case — so
// falling back to the Business Portfolio path isn't optional polish, it's
// what most real business accounts actually need. business_management
// scope required for the fallback; if it's missing (not granted, or the
// call fails for any other reason) this degrades to just the classic
// /me/accounts result rather than throwing.
export async function listPages(accessToken) {
  const direct = await metaFetch("/me/accounts?fields=id,name,category", { accessToken });
  if (direct.data?.length) return direct.data;

  const businesses = await metaFetch("/me/businesses?fields=id,name", { accessToken }).catch(() => ({ data: [] }));
  const perBusiness = await Promise.all(
    (businesses.data || []).map((b) =>
      metaFetch(`/${b.id}/owned_pages?fields=id,name,category`, { accessToken }).catch(() => ({ data: [] }))
    )
  );
  const seen = new Set();
  const pages = [];
  for (const result of perBusiness) {
    for (const page of result.data || []) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      pages.push(page);
    }
  }
  return pages;
}

// Reading a Page's own content (/{page-id}/posts) needs a PAGE access
// token — confirmed live: the user access token, even with
// pages_read_engagement granted, gets rejected outright with "(#190)
// Invalid OAuth 2.0 Access Token" on this specific edge, while metadata
// calls (listPages, getInstagramAccountId) using that same user token
// worked fine moments earlier. This is a real, separate Graph API
// requirement, not another instance of the Business Portfolio gap:
// Meta exchanges a page-scoped token per Page, and content-reading edges
// require it explicitly rather than accepting the broader user token.
// /{pageId}?fields=access_token returns it directly for classically-
// linked pages; Business Portfolio-owned pages need the same
// owned_pages fallback as listPages(), requesting access_token instead
// of category this time. Returns null (never throws) so callers can
// fall back to the user token rather than hard-failing when neither
// path has it — e.g. a page role that doesn't include content access.
// Never returned through a tool response — this is a live secret, kept
// server-side only.
export async function getPageAccessToken(accessToken, pageId) {
  const direct = await metaFetch(`/${pageId}?fields=access_token`, { accessToken }).catch(() => ({}));
  if (direct.access_token) return direct.access_token;

  const businesses = await metaFetch("/me/businesses?fields=id,name", { accessToken }).catch(() => ({ data: [] }));
  for (const business of businesses.data || []) {
    const pages = await metaFetch(`/${business.id}/owned_pages?fields=id,access_token`, { accessToken }).catch(() => ({ data: [] }));
    const match = (pages.data || []).find((p) => p.id === pageId);
    if (match?.access_token) return match.access_token;
  }
  return null;
}

export async function createAdSet(accessToken, adAccountId, fields) {
  return metaFetch(`/${normalizeAdAccountId(adAccountId)}/adsets`, { accessToken, method: "POST", body: fields });
}

// Meta's Ad Images endpoint accepts base64 bytes directly in a JSON body
// (the `bytes` field) as an alternative to a multipart file upload — no
// multipart handling needed. Response is keyed by an arbitrary internal
// name Meta assigns, not something a caller picks, so just take whichever
// single entry comes back.
export async function uploadAdImage(accessToken, adAccountId, base64Bytes) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/adimages`, {
    accessToken, method: "POST", body: { bytes: base64Bytes },
  });
  const first = Object.values(data.images || {})[0];
  if (!first) throw new Error("Meta did not return an image hash for the uploaded image.");
  return { hash: first.hash, url: first.url };
}

// file_url has Meta's own server fetch and transcode the video, instead of
// this app doing a multipart/chunked upload of the bytes itself — much
// simpler, and the only reason a video upload can be scoped to "single
// video ads" without a much bigger chunked-upload implementation. Returns
// immediately; the video isn't necessarily ready to reference in a creative
// yet (tools/meta/campaigns.js's create_video_ad handles that boundary).
export async function uploadAdVideoFromUrl(accessToken, adAccountId, videoUrl, name) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/advideos`, {
    accessToken, method: "POST", body: { file_url: videoUrl, name },
  });
  return { videoId: data.id };
}

export async function createAdCreative(accessToken, adAccountId, fields) {
  return metaFetch(`/${normalizeAdAccountId(adAccountId)}/adcreatives`, { accessToken, method: "POST", body: fields });
}

export async function createAd(accessToken, adAccountId, fields) {
  return metaFetch(`/${normalizeAdAccountId(adAccountId)}/ads`, { accessToken, method: "POST", body: fields });
}

// A Page's own recent organic posts — for "boost this post" (meta.boost_post),
// same mechanism as the "Boost" button in Meta's own tools: an ad creative
// that points at an existing post (object_story_id) instead of uploading new
// creative content. Requires pages_read_engagement in addition to
// pages_show_list (which only lists which Pages exist, not their content).
// likes.summary(true)/comments.summary(true)/shares are real counts
// returned directly on the post object — no extra per-post call needed —
// used by Meta Ads Expert V2's business snapshot (businessSnapshot.js) to
// show REAL engagement numbers instead of letting the model guess at
// "high engagement" from nothing.
export async function listPagePosts(accessToken, pageId) {
  const pageToken = await getPageAccessToken(accessToken, pageId);
  const data = await metaFetch(`/${pageId}/posts?fields=id,message,created_time,permalink_url,attachments{media_type,url,media},likes.summary(true),comments.summary(true),shares`, { accessToken: pageToken || accessToken });
  return data.data || [];
}

// A Page's Instagram Business Account isn't the Page itself — it's a
// separate id one hop away, only present if the Page actually has an IG
// account connected via the CLASSIC per-Page link. Same Business Portfolio
// gap as listPages() above: an Instagram account owned by a Business
// Portfolio (Business Settings > Instagram accounts) doesn't show up here
// at all — confirmed live for the same real account whose Pages hit this
// exact issue. Falls back to checking the account's Business Portfolios
// directly. Not strictly page-specific (a Business Portfolio's Instagram
// accounts aren't necessarily tied to one particular Page in this API
// response) — correct for the common one-portfolio-one-IG-account case;
// someone with several portfolios each holding their own Instagram account
// could get an ambiguous match here.
export async function getInstagramAccountId(accessToken, pageId) {
  const data = await metaFetch(`/${pageId}?fields=instagram_business_account`, { accessToken });
  if (data.instagram_business_account?.id) return data.instagram_business_account.id;

  const businesses = await metaFetch("/me/businesses?fields=id,name", { accessToken }).catch(() => ({ data: [] }));
  for (const business of businesses.data || []) {
    const igAccounts = await metaFetch(`/${business.id}/instagram_accounts?fields=id,username`, { accessToken }).catch(() => ({ data: [] }));
    if (igAccounts.data?.length) return igAccounts.data[0].id;
  }
  return null;
}

// like_count/comments_count are real counts returned directly on the
// media object — no extra per-post call needed. Same purpose as
// listPagePosts' engagement fields above.
export async function listInstagramPosts(accessToken, igAccountId) {
  const data = await metaFetch(`/${igAccountId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count`, { accessToken });
  return data.data || [];
}

// Meta Pixels (conversion tracking) live under the ad account, not the
// user — /act_{id}/adspixels. Needed by the Meta Expert planner (Phase 1)
// to know whether Purchase-optimized campaigns are even possible before
// recommending one. Most accounts that have never run conversion
// campaigns simply have none — that's a normal, expected empty result,
// not an error.
export async function listPixels(accessToken, adAccountId) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/adspixels?fields=id,name`, { accessToken });
  return data.data || [];
}

// Product catalogs (for dynamic/catalog ads) — also ad-account-scoped.
// Same "commonly empty, not an error" reasoning as listPixels: most
// accounts without a product feed set up will simply have none.
export async function listCatalogs(accessToken, adAccountId) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/product_catalogs?fields=id,name`, { accessToken });
  return data.data || [];
}
