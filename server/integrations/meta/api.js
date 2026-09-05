import { logger } from "../../config/logger.js";

// Verified against Meta's Graph API changelog (developers.facebook.com/
// docs/graph-api/changelog) on 2026-08-31: v25.0 is the current stable
// version — v23.0 reached end-of-life on 2026-06-09, and v20.0 is
// scheduled for deprecation 2026-09-24. v26.0 has been announced but was
// not yet generally available as of this check, so v25.0 is the safe
// current default; override via META_API_VERSION once a newer version is
// confirmed stable.
const API_VERSION = process.env.META_API_VERSION || "v25.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

// Walks a raw fetch()-level exception's .cause chain (Node's undici throws
// `TypeError: fetch failed` with the REAL error — ECONNREFUSED, ENOTFOUND,
// ETIMEDOUT, a TLS failure, etc. — nested one or more .cause levels deep,
// sometimes an AggregateError with multiple attempts in .errors) into a
// flat, loggable list. Never assumes a fixed depth or shape.
function describeNetworkError(err) {
  const chain = [];
  let current = err;
  let depth = 0;
  while (current && depth < 5) {
    chain.push({ name: current.name, message: current.message, code: current.code });
    if (Array.isArray(current.errors) && current.errors.length) {
      for (const inner of current.errors) chain.push({ name: inner.name, message: inner.message, code: inner.code });
      break;
    }
    current = current.cause;
    depth += 1;
  }
  return chain;
}

// Redacts a token to its first/last 6 chars so a real outgoing request can
// be logged and diffed against a known-good manual call (e.g. Graph API
// Explorer) without ever writing the live secret to logs.
function redactToken(token) {
  if (typeof token !== "string" || token.length <= 12) return "[REDACTED]";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

async function metaFetch(path, { accessToken, method = "GET", body }) {
  const url = new URL(`${BASE}${path}`);
  if (method === "GET") url.searchParams.set("access_token", accessToken);
  const headers = { "content-type": "application/json" };
  // Diagnostic (live bug: a page token proven working by hand in Graph API
  // Explorer still hit Meta's real "(#10) requires pages_read_engagement
  // or Page Public Content Access" error through this exact code path).
  // Logs the REAL outgoing URL/headers this fetch() call is about to send
  // — built from the same `url`/`headers` values, not a reconstruction —
  // so it can be diffed field-for-field against a manual Explorer call.
  // Token redacted to its first/last 6 chars; this file uses query-param
  // auth only (no Authorization header exists to redact).
  const loggableUrl = new URL(url);
  if (loggableUrl.searchParams.has("access_token")) loggableUrl.searchParams.set("access_token", redactToken(loggableUrl.searchParams.get("access_token")));
  logger.info("meta_api.outgoing_request", { method, url: loggableUrl.toString(), headers });
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify({ ...body, access_token: method !== "GET" ? accessToken : undefined }) : undefined,
    });
  } catch (err) {
    // Diagnostic (user-reported live failure: a call logged its request,
    // then nothing — no response, no meta_api.request_failed — because
    // fetch() itself threw before an HTTP response ever existed, which
    // the request_failed log below can't see since it needs a real `res`
    // to read a status/body from). Previously silent; this is the ONLY
    // place in this file that can observe a raw network-level failure,
    // so every caller gets it for free rather than needing its own catch.
    logger.error("meta_api.network_error", { path, method, chain: describeNetworkError(err) });
    throw err;
  }
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

// isAdsetBudgetSharingEnabled: optional, new (round 31 live bug) — a
// campaign created with NO campaign-level budget (ABO — see
// metaExpertV2/executor.js's executeCampaignMode) now gets rejected by
// Meta with "You must specify True or False in the field
// is_adset_budget_sharing_enabled if you are not using campaign budget"
// (error 100/4834011) unless this is explicitly declared. Left undefined
// (dropped from the request body, exactly as before) for every existing
// caller that doesn't pass it — V1's own callers, and V2's
// executeExplicitAction (which sets a campaign-level budget/CBO, so this
// field's error condition doesn't apply there) — never sending it unless
// a caller opts in.
export async function createCampaign(accessToken, adAccountId, { name, objective, dailyBudget, status = "PAUSED", isAdsetBudgetSharingEnabled }) {
  return metaFetch(`/${normalizeAdAccountId(adAccountId)}/campaigns`, {
    accessToken,
    method: "POST",
    body: { name, objective, status, daily_budget: dailyBudget, is_adset_budget_sharing_enabled: isAdsetBudgetSharingEnabled, special_ad_categories: [] },
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
//
// Live bug (user-reported, second investigation): production logs showed
// this "direct" resolution succeeding (truthy access_token) and
// listPagePosts still failing downstream with Meta's real "(#10)
// requires pages_read_engagement or Page Public Content Access" error —
// while manually generating a page token for the SAME page via Graph API
// Explorer worked immediately. RESOLVED by live Explorer bisection: this
// "direct" resolution (/{pageId}?fields=access_token) was never the
// problem — a token obtained this exact way was proven to work, by hand,
// against /{pageId}/posts. The real cause was listPagePosts requesting
// fields Meta gates behind permissions this app doesn't fully have (see
// that function's own comment). No change needed here.
//
// What IS fixed here, independent of that: the "never
// silently fall back when a required credential can't be obtained" rule
// (proven necessary for the currency symbol, false completion claims,
// and goal substitution already this project) was being violated —
// returning null let listPagePosts silently retry with the broader user
// token. That fallback is gone; this now THROWS a named, distinct error
// instead of returning null.
// Never returned through a tool response — this is a live secret, kept
// server-side only.
export async function getPageAccessToken(accessToken, pageId) {
  const direct = await metaFetch(`/${pageId}?fields=access_token`, { accessToken }).catch(() => ({}));
  if (direct.access_token) {
    logger.info("meta_api.get_page_access_token", { pageId, resolution: "direct" });
    return direct.access_token;
  }

  const businesses = await metaFetch("/me/businesses?fields=id,name", { accessToken }).catch(() => ({ data: [] }));
  for (const business of businesses.data || []) {
    const pages = await metaFetch(`/${business.id}/owned_pages?fields=id,access_token`, { accessToken }).catch(() => ({ data: [] }));
    const match = (pages.data || []).find((p) => p.id === pageId);
    if (match?.access_token) {
      logger.info("meta_api.get_page_access_token", { pageId, resolution: "business_portfolio", businessId: business.id });
      return match.access_token;
    }
  }
  // businessesChecked distinguishes "no Business Portfolio to even check"
  // (0) from "checked N, none had this page" (>0) — different real
  // causes for the same failure, both genuinely unrecoverable here.
  const businessesChecked = (businesses.data || []).length;
  logger.error("meta_api.get_page_access_token_failed", { pageId, businessesChecked });
  const err = new Error(`Could not obtain a Page access token for Page ${pageId} — it wasn't found via /{pageId}?fields=access_token or any connected Business Portfolio (${businessesChecked} checked).`);
  err.code = "META_PAGE_TOKEN_UNAVAILABLE";
  throw err;
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
//
// Root cause (confirmed by live Explorer bisection, same app/page/token,
// v25.0): Meta rejects the ENTIRE call with "(#10) requires
// pages_read_engagement or Page Public Content Access" if ANY requested
// field is gated — it isn't all-or-nothing per permission, it's
// all-or-nothing per REQUEST. `likes.summary(true)` needs
// pages_read_engagement (which we DO have); `comments.summary(true)`
// needs pages_read_user_content (which we do NOT have — not in this
// app's OAuth SCOPES, not added via App Review; a separate future
// decision, not a bug). Requesting engagement fields at all — even ones
// we're actually entitled to — broke the whole post read. Fields below
// are exactly what a bare Explorer `/{pageId}/posts` call (no `fields`
// param) returns by default, proven working live for this same page.
// Consequence (standing rule: no fabricated defaults for a field that
// isn't fetched): businessSnapshot.js's normalizeContentItem() already
// treats a missing likes/comments/shares key as "unavailable," not 0 —
// so real engagement counts for Facebook Page posts are simply never
// present again until pages_read_user_content is granted; nothing
// downstream needs a code change to handle that, it already does.
export async function listPagePosts(accessToken, pageId) {
  // getPageAccessToken now THROWS (META_PAGE_TOKEN_UNAVAILABLE) instead
  // of ever returning null — this call either gets a genuine Page token
  // or never reaches the fetch below at all. Previously this fell back
  // to the broader user token (`pageToken || accessToken`) whenever a
  // Page token couldn't be obtained, which is exactly the "protective
  // logic that assumes a case can't happen" pattern this project has
  // banned project-wide — a fallback here would silently retry with a
  // token that may be exactly what's causing the real failure, hiding it
  // instead of surfacing it. credentialSource is now unconditionally
  // "page" because there is no other path left to log — the label can no
  // longer be wrong.
  const pageToken = await getPageAccessToken(accessToken, pageId);
  // Diagnostic (user-reported live failure: the model's own reply claimed
  // "a permissions issue" reading this Page's posts even though Meta's
  // own /me/permissions confirmed pages_read_engagement IS granted — so
  // the real cause is something else this call itself can now show).
  // Logged the same way execute_strategy already logs its own request/
  // response payloads (executor.js) — a real failure is already fully
  // logged by metaFetch's own meta_api.request_failed (code/subcode/
  // message/error_user_msg/fbtrace_id); this adds the success path
  // (previously silent). Deliberately named credentialSource, not
  // "...Token..." — logger.js's redact() strips any field whose KEY
  // matches /token/i regardless of its value, which would have silently
  // hidden this exact diagnostic.
  logger.info("meta_api.list_page_posts.request", { pageId, credentialSource: "page" });
  const data = await metaFetch(`/${pageId}/posts?fields=id,message,created_time,permalink_url,attachments{media_type,url,media}`, { accessToken: pageToken });
  logger.info("meta_api.list_page_posts.response", { pageId, postCount: (data.data || []).length, raw: data });
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

// --- Ad-level read/fetch helpers ------------------------------------------
// Genuinely missing before this: campaigns (listCampaigns/createCampaign)
// already had both a list and a single-entity write path, but ad sets and
// ads only had writes (createAdSet/createAd above) with no way to read one
// back — needed for anything that has to check a real ad set/ad's current
// status or fields after creation (e.g. verifying an execute step actually
// took effect) rather than trusting the create response alone.

// account_status/currency/timezone_name are already read ad-hoc elsewhere
// via listAdAccounts' bulk /me/adaccounts call; this is the single-entity
// equivalent for when the caller already has one specific ad account id
// (e.g. re-checking currency right before a currency-sensitive write,
// without re-fetching and re-filtering the whole account list).
export async function getAdAccount(accessToken, adAccountId) {
  return metaFetch(`/${normalizeAdAccountId(adAccountId)}?fields=id,name,account_status,currency,timezone_name,amount_spent,balance`, { accessToken });
}

export async function getAdSet(accessToken, adSetId) {
  return metaFetch(`/${adSetId}?fields=id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,targeting`, { accessToken });
}

export async function getAd(accessToken, adId) {
  return metaFetch(`/${adId}?fields=id,name,status,adset_id,campaign_id,creative`, { accessToken });
}

// Read-back verification for a just-created ad's actual creative (Meta
// Ads Expert V2's creative-attach step, executor.js) — getAd above only
// returns the creative as a bare {id} reference; this expands it so the
// executor can confirm what Meta actually stored (object_story_id /
// instagram_user_id+source_instagram_media_id for a boosted post, or the
// link_data image_hash/link for a product-image ad) genuinely matches
// what was sent, rather than trusting the create call's response alone.
export async function getAdCreative(accessToken, creativeId) {
  return metaFetch(`/${creativeId}?fields=id,name,object_story_id,object_story_spec`, { accessToken });
}

// Ad-account-scoped, same shape as the existing listCampaigns — ad sets
// span campaigns within an account, so this lists all of them rather than
// requiring a specific campaign id up front.
export async function listAdSets(accessToken, adAccountId) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/adsets?fields=id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy`, { accessToken });
  return data.data || [];
}

export async function listAds(accessToken, adAccountId) {
  const data = await metaFetch(`/${normalizeAdAccountId(adAccountId)}/ads?fields=id,name,status,adset_id,campaign_id,creative`, { accessToken });
  return data.data || [];
}

// --- Carousel creative support --------------------------------------------
// The existing creative paths (meta.create_image_ad/meta.create_video_ad
// in tools/meta/campaigns.js) build a single-image or single-video
// object_story_spec.link_data/video_data directly. A carousel ad is the
// same link_data shape but with multiple cards, each needing its own
// already-uploaded image_hash (via uploadAdImage above) — expressed as
// object_story_spec.link_data.child_attachments, an array Meta hard-caps
// at 10 cards. This builds that shape and enforces the cap locally so a
// caller gets an immediate, clear error instead of a round-trip Meta
// rejection; it does not upload anything itself — each card's imageHash
// must already come from a prior uploadAdImage call. Pure data-shaping
// helper, not a fetch — createAdCreative (existing) is still what actually
// sends it to Meta.
const MAX_CAROUSEL_CARDS = 10;
export function buildCarouselLinkData({ link, message, cards }) {
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error("A carousel ad needs at least one card.");
  }
  if (cards.length > MAX_CAROUSEL_CARDS) {
    throw new Error(`A carousel ad supports at most ${MAX_CAROUSEL_CARDS} cards (got ${cards.length}).`);
  }
  for (const [i, card] of cards.entries()) {
    if (!card.imageHash) throw new Error(`Carousel card ${i + 1} is missing imageHash (upload it with uploadAdImage first).`);
    if (!card.link && !link) throw new Error(`Carousel card ${i + 1} has no link, and no fallback link was given.`);
  }
  return {
    link,
    message,
    child_attachments: cards.map((card) => ({
      link: card.link || link,
      name: card.name,
      description: card.description,
      image_hash: card.imageHash,
    })),
  };
}
