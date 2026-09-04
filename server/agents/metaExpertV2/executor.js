// Meta Ads Expert V2 — Internal Execution Layer (Step 8/9). The ONLY code
// path that ever spends real money for a V2 strategy. Never reachable from
// the LLM directly — meta_expert_v2.execute_strategy (the tool wrapping
// this) is the sole entry point, and it only ever loads an ALREADY-
// approved, backend-validated strategy; nothing here reconstructs a
// campaign payload from what the model says in the moment.
//
// Reuses the existing, proven raw Meta primitives rather than
// reimplementing them: meta.createCampaign/meta.createAdSet directly
// (server/integrations/meta/api.js — the same functions the original
// planner's execute_campaign_plan already uses), and for an explicit
// action, the ALREADY-REGISTERED meta.boost_post / meta.create_image_ad
// tools' own execute() functions (server/tools/meta/campaigns.js) called
// directly as internal functions — never dispatched through the tool
// registry's LLM-facing path, and never exposed in this agent's skillIds
// (see server/tools/meta/metaExpertV2.js).
import * as meta from "../../integrations/meta/api.js";
import { getTool } from "../../tools/registry.js";
import { buildTargeting } from "../../tools/meta/campaigns.js";
import { publishEvent } from "../../automation/triggers.js";
import { MAX_EXECUTABLE_DAILY_BUDGET } from "./policy.js";
import { getStoredStrategy, getActiveStrategyForConversation, EXECUTABLE_STATUSES, markStrategyApproved, setStrategyStatus, markStrategyExecuted, markStrategyFailed, markStrategyRejected } from "./strategyStore.js";
import { assertV2RuntimeEnabled } from "./runtimeGate.js";
import { logger } from "../../config/logger.js";

// Live bug (round 20): a PKR ad account, "budget_daily: 500" (the user's
// own words, "500/day", meaning 500 whole Rupees), and Meta's real Ad Set
// creation STILL rejected it as too low: "(#100/3858558) To avoid zero
// results, your budget must be at least PKR250.00" — 500 > 250, so this
// made no sense until traced to the actual root cause: Meta's Marketing
// API requires daily_budget in the ad account's currency's SMALLEST unit
// (100 = $1.00 for USD, 100 = PKR 1.00 for PKR — same 2-decimal
// convention), which the internal schema's own field description already
// says ("In the ad account's currency's smallest unit") — but nothing in
// this codebase ever actually did that conversion. budget_daily is set
// and compared everywhere else (MAX_SUGGESTED_DAILY_BUDGET/
// MAX_EXECUTABLE_DAILY_BUDGET, the user's own "500/day" wording, every
// policy check) in ordinary MAJOR units (whole Rupees/Dollars) — the only
// place minor units actually matter is the literal Meta API call, so the
// conversion happens ONLY here, right before that call, never touching
// the stored/displayed/compared value anywhere else. A small number of
// real currencies (JPY, KRW, VND, and others Meta treats the same way as
// Stripe's documented zero-decimal set) have no minor unit at all — their
// multiplier is 1, everything else defaults to 100. Three-decimal
// currencies (e.g. BHD/KWD/OMR) are deliberately NOT special-cased here —
// too small an edge case to guess Meta's exact behavior for without a
// live account to verify against; PKR/USD/EUR/GBP and the vast majority
// of real currencies are unaffected by that omission.
const META_ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
function currencyMinorUnitMultiplier(currencyCode) {
  if (typeof currencyCode !== "string" || !currencyCode) return 100;
  return META_ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase()) ? 1 : 100;
}
function toMetaBudgetMinorUnits(majorAmount, currencyCode) {
  if (typeof majorAmount !== "number" || !Number.isFinite(majorAmount)) return majorAmount;
  return Math.round(majorAmount * currencyMinorUnitMultiplier(currencyCode));
}

// Meta's real Ad Set optimization_goal enum doesn't include "PURCHASE" (or
// this strategy's other custom-event-style optimization_event values) —
// conversion events are optimized via optimization_goal: "OFFSITE_
// CONVERSIONS" plus a promoted_object naming the Pixel and which specific
// event to optimize for. Same mapping the original planner's execution
// step already established as correct against Meta's real API.
const CONVERSION_EVENT_TO_META_GOAL = { PURCHASE: "OFFSITE_CONVERSIONS", ADD_TO_CART: "OFFSITE_CONVERSIONS", LEAD: "OFFSITE_CONVERSIONS", COMPLETE_REGISTRATION: "OFFSITE_CONVERSIONS" };
function buildOptimizationFields(strategy, resolvedPixelId) {
  const metaGoal = CONVERSION_EVENT_TO_META_GOAL[strategy.optimization_event];
  if (!metaGoal) return { optimization_goal: strategy.optimization_event || "LINK_CLICKS" };
  return { optimization_goal: metaGoal, promoted_object: { pixel_id: resolvedPixelId, custom_event_type: strategy.optimization_event } };
}

// Live bug (round 31, third recurrence): "You can't use the selected
// performance goal with your campaign objective. Please select a
// different goal, or edit your campaign." (Meta error 100/2490408).
// Traced via the round-31 diagnostic logging to promoted_object.pixel_id:
// null in the actual ad set request — optimization_event was PURCHASE
// (requires OFFSITE_CONVERSIONS + a real promoted_object), but
// resolvedAssets.pixelId was null. Root cause: a strategy with a
// genuinely ambiguous Pixel (2+ Pixels, no default) is correctly stored
// with a real unresolved_questions entry and pixelId left null
// (strategyBuilder.js) — nothing previously blocked execution while that
// question was still open (fixed separately: checkV2ExecutionApprovalGate/
// executeStrategy's own unresolved_questions check above).
//
// Rather than fix one field per round as each new Meta rejection reveals
// it, this validates the WHOLE objective/optimization_goal/promoted_object
// combination once, right before anything is sent, and fails with a clear
// message naming the exact bad pairing — never another cryptic Meta
// rejection reaching the customer for a combination this codebase itself
// produced. OBJECTIVE_ALLOWED_OPTIMIZATION_EVENTS is deliberately scoped
// to the exact enums this strategy schema supports (internal_strategy_
// schema.json) and Meta's real, documented Outcome-Driven Ads Experiences
// objective/optimization-goal compatibility — not an attempt at Meta's
// full API surface, which this codebase never needs since these are the
// only combinations it can ever generate.
const OBJECTIVE_ALLOWED_OPTIMIZATION_EVENTS = {
  OUTCOME_SALES: new Set(["PURCHASE", "ADD_TO_CART", "LINK_CLICKS", "LANDING_PAGE_VIEWS"]),
  OUTCOME_TRAFFIC: new Set(["LINK_CLICKS", "LANDING_PAGE_VIEWS", "REACH", "IMPRESSIONS"]),
  OUTCOME_LEADS: new Set(["LEAD", "COMPLETE_REGISTRATION", "LINK_CLICKS", "LANDING_PAGE_VIEWS"]),
  OUTCOME_ENGAGEMENT: new Set(["THRUPLAY", "LINK_CLICKS", "IMPRESSIONS", "REACH"]),
  OUTCOME_AWARENESS: new Set(["REACH", "IMPRESSIONS", "THRUPLAY"]),
  OUTCOME_APP_PROMOTION: new Set(["APP_INSTALLS", "LINK_CLICKS"]),
};
function validateCampaignFieldCombination(strategy, resolvedAssets, targeting) {
  const allowedEvents = OBJECTIVE_ALLOWED_OPTIMIZATION_EVENTS[strategy.recommended_objective];
  if (allowedEvents && !allowedEvents.has(strategy.optimization_event)) {
    const err = new Error(`Invalid pairing: campaign objective "${strategy.recommended_objective}" cannot use optimization_event "${strategy.optimization_event}" — Meta rejects this combination. Build a revised strategy with a compatible optimization_event, or a compatible objective.`);
    err.code = "META_V2_INVALID_FIELD_COMBINATION";
    throw err;
  }
  // OFFSITE_CONVERSIONS (any conversion-event optimization) requires a
  // real, resolved Pixel to name in promoted_object — Meta rejects the ad
  // set with an unrelated-sounding "performance goal" error when this is
  // missing rather than naming the Pixel directly (the exact live bug
  // this validator exists to catch before it ever reaches Meta).
  if (CONVERSION_EVENT_TO_META_GOAL[strategy.optimization_event] && !resolvedAssets.pixelId) {
    const err = new Error(`optimization_event "${strategy.optimization_event}" requires a real Meta Pixel (promoted_object.pixel_id), but none is resolved for this strategy. Build a revised strategy once a Pixel is chosen.`);
    err.code = "META_V2_INVALID_FIELD_COMBINATION";
    throw err;
  }
  // Live bug (round 31, fourth recurrence): Meta now hard-requires
  // targeting_automation.advantage_audience to be explicitly 0 or 1 — no
  // default, and omitting it entirely is rejected outright ("you need to
  // enable or disable the Advantage audience feature," Meta error
  // 100/1870227). buildV2Targeting below always sets it, so a failure
  // here means some future code path built a targeting spec that skipped
  // it — caught here, before ANY Meta call, rather than as a round trip
  // to Meta's API to rediscover the same mandatory field a second time.
  const advantageAudience = targeting?.targeting_automation?.advantage_audience;
  if (advantageAudience !== 0 && advantageAudience !== 1) {
    const err = new Error("targeting_automation.advantage_audience must be explicitly 0 or 1 — Meta requires this field with no default and rejects the ad set outright when it's missing.");
    err.code = "META_V2_INVALID_FIELD_COMBINATION";
    throw err;
  }
}

// Live bug (round 31, fourth recurrence): "To create your ad set, you need
// to enable or disable the Advantage audience feature. This can be done by
// setting the advantage_audience flag to either 1 or 0 within the
// targeting_automation field in the targeting spec." (Meta error
// 100/1870227) — a newer Meta API requirement with no default; omitting
// the field entirely is rejected. Always 0 for every V2 campaign-mode
// strategy — never Meta's audience-EXPANSION default: the strategy names
// an explicit audience (gender/age/countries) the user actually approved,
// and Meta's "Advantage audience" (value 1) is documented to let Meta
// expand DELIVERY beyond that stated targeting on its own — silently
// running against people outside what was approved is exactly the class
// of drift a real spend decision must never be subject to unasked. If a
// future strategy genuinely wants broad/automatic audience expansion,
// that must become a real field on the strategy schema the user sees and
// approves, never a value hardcoded here without their knowledge.
function buildV2Targeting(strategy) {
  return {
    ...buildTargeting({ countries: strategy.countries, ageMin: strategy.age_min, ageMax: strategy.age_max, gender: strategy.gender === "ALL" ? undefined : strategy.gender?.toLowerCase() }),
    targeting_automation: { advantage_audience: 0 },
  };
}

// Creative attach (Phase 1 follow-up) — a campaign-mode strategy's real
// creative was already resolved at build/revise time (creativeResolution.js,
// stored on resolvedAssets.creative — never re-derived here). This builds
// the same request shapes meta.boost_post/meta.create_image_ad
// (tools/meta/campaigns.js) already use, but calls meta.createAdCreative/
// meta.createAd DIRECTLY rather than through those tools' execute()
// wrappers — the ONLY reason being that this file's own always-on
// diagnostic logging (see executeCampaignMode's comment) needs the real
// request bodies, which the tool wrappers don't expose to a caller.
// resolvedAssets.creative is null for the three sources explicitly out of
// scope this session (GENERATED_IMAGE/GENERATED_VIDEO/USER_ATTACHED_MEDIA
// — see creativeResolution.js) or for a strategy stored before this
// feature existed — the campaign/ad set are still created either way,
// just honestly reported as not having a creative attached, never
// silently skipped without saying so.
const CREATIVE_UNSUPPORTED_SOURCES = new Set(["GENERATED_IMAGE", "GENERATED_VIDEO", "USER_ATTACHED_MEDIA"]);
async function attachCampaignCreative(stored, accessToken, adAccountId, adSetId, campaignId, pageId) {
  const { strategy, resolvedAssets } = stored;
  const creative = resolvedAssets.creative;
  if (!creative) {
    const source = strategy.creative_strategy?.source;
    const skippedReason = CREATIVE_UNSUPPORTED_SOURCES.has(source)
      ? `creative_strategy.source "${source}" isn't supported for automatic ad attach yet — the campaign and ad set were created (paused), but you'll need to add the actual ad creative manually in Ads Manager.`
      : "No creative was resolved for this strategy — the campaign and ad set were created (paused), but no ad was attached.";
    return { adId: null, creativeId: null, attached: false, skippedReason };
  }

  let creativeFields;
  if (creative.source === "EXISTING_PAGE_POST") {
    creativeFields = { name: `${strategy.business_goal} — creative`, object_story_id: creative.contentId };
  } else if (creative.source === "EXISTING_INSTAGRAM_POST") {
    const igAccountId = await meta.getInstagramAccountId(accessToken, pageId);
    if (!igAccountId) throw new Error("This Page has no Instagram Business Account connected — cannot attach the resolved Instagram post.");
    // instagram_user_id, not instagram_actor_id — Meta deprecated the
    // latter in Marketing API v22.0 (migration deadline Jan 21, 2026,
    // already passed); source_instagram_media_id is unaffected. Both
    // belong INSIDE object_story_spec (confirmed against Meta's own
    // docs) — a flat top-level pair is silently ignored by the real API,
    // which is exactly why the read-back verification below (checking
    // object_story_spec.source_instagram_media_id) previously could never
    // have passed against a real account.
    creativeFields = { name: `${strategy.business_goal} — creative`, object_story_spec: { instagram_user_id: igAccountId, source_instagram_media_id: creative.contentId } };
  } else if (creative.source === "PRODUCT_IMAGE") {
    const imgRes = await fetch(creative.imageUrl);
    if (!imgRes.ok) throw new Error(`Could not fetch the resolved product image from ${creative.imageUrl}`);
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
    const { hash } = await meta.uploadAdImage(accessToken, adAccountId, base64);
    creativeFields = {
      name: `${strategy.business_goal} — creative`,
      object_story_spec: { page_id: pageId, link_data: { image_hash: hash, message: creative.primaryText, name: creative.productName, link: creative.link } },
    };
  } else {
    throw new Error(`Unrecognized resolved creative source "${creative.source}".`);
  }

  logger.info("meta_expert_v2.execute_strategy.creative_request", { strategyId: stored.id, adAccountId, body: creativeFields });
  const adCreative = await meta.createAdCreative(accessToken, adAccountId, creativeFields);
  logger.info("meta_expert_v2.execute_strategy.creative_response", { strategyId: stored.id, adCreative });

  const adFields = { name: strategy.business_goal, adset_id: adSetId, creative: { creative_id: adCreative.id }, status: "PAUSED" };
  logger.info("meta_expert_v2.execute_strategy.ad_request", { strategyId: stored.id, adAccountId, body: adFields });
  const ad = await meta.createAd(accessToken, adAccountId, adFields);
  logger.info("meta_expert_v2.execute_strategy.ad_response", { strategyId: stored.id, ad });

  // Read-back verification (requirement: confirm the created ad actually
  // matches the plan, not just trust the create call's own response) —
  // re-fetches both the ad and its creative directly from Meta and checks
  // them against what this call actually intended, rather than assuming
  // a 200 response means the real stored object is correct.
  const verifyAd = await meta.getAd(accessToken, ad.id);
  if (verifyAd.status !== "PAUSED" || verifyAd.adset_id !== adSetId || verifyAd.campaign_id !== campaignId) {
    throw new Error(`Ad verification failed: readback (status=${verifyAd.status}, adset_id=${verifyAd.adset_id}, campaign_id=${verifyAd.campaign_id}) does not match what was created (expected status=PAUSED, adset_id=${adSetId}, campaign_id=${campaignId}).`);
  }
  const verifyCreative = await meta.getAdCreative(accessToken, adCreative.id);
  if (creative.source === "EXISTING_PAGE_POST" && verifyCreative.object_story_id !== creative.contentId) {
    throw new Error(`Creative verification failed: readback object_story_id (${verifyCreative.object_story_id}) does not match the resolved post (${creative.contentId}).`);
  }
  if (creative.source === "EXISTING_INSTAGRAM_POST" && verifyCreative.object_story_spec?.source_instagram_media_id !== creative.contentId) {
    throw new Error(`Creative verification failed: readback source_instagram_media_id (${verifyCreative.object_story_spec?.source_instagram_media_id}) does not match the resolved post (${creative.contentId}).`);
  }
  if (creative.source === "PRODUCT_IMAGE" && verifyCreative.object_story_spec?.link_data?.link !== creative.link) {
    throw new Error(`Creative verification failed: readback link (${verifyCreative.object_story_spec?.link_data?.link}) does not match the resolved product link (${creative.link}).`);
  }
  logger.info("meta_expert_v2.execute_strategy.readback_verify", { strategyId: stored.id, adId: ad.id, creativeId: adCreative.id, verifiedAgainstPlan: true });

  return { adId: ad.id, creativeId: adCreative.id, attached: true, skippedReason: null };
}

function loadExecutable(userId, conversationId, strategyId) {
  const stored = strategyId ? getStoredStrategy(userId, strategyId) : getActiveStrategyForConversation(userId, conversationId);
  if (!stored) {
    const err = new Error(strategyId ? `No strategy found with id "${strategyId}" for this account.` : "No current strategy exists for this conversation.");
    err.code = "META_V2_STRATEGY_REQUIRED";
    throw err;
  }
  if (strategyId && stored.conversationId && conversationId && stored.conversationId !== conversationId) {
    const err = new Error(`Strategy "${strategyId}" belongs to a different conversation, not this one — it can't be executed here.`);
    err.code = "META_V2_STRATEGY_REQUIRED";
    throw err;
  }
  if (!EXECUTABLE_STATUSES.has(stored.status)) {
    const err = new Error(stored.status === "executed" ? "This strategy has already been executed — build a new strategy for another campaign." : `This strategy is no longer active (status: ${stored.status}) — build a new strategy.`);
    err.code = "META_V2_STRATEGY_REQUIRED";
    throw err;
  }
  return stored;
}

async function executeCampaignMode(stored, accessToken, userId, currency) {
  const { strategy, resolvedAssets } = stored;
  const targeting = buildV2Targeting(strategy);
  // Fail fast, before any Meta network call (including the campaign
  // create — a broken targeting spec is now caught before that call too,
  // rather than after a campaign already exists that then needs cleanup)
  // — see validateCampaignFieldCombination's own comment above.
  validateCampaignFieldCombination(strategy, resolvedAssets, targeting);
  const minorUnitBudget = toMetaBudgetMinorUnits(strategy.budget_daily, currency);
  // Defense in depth — deriveXIfMissing/normalizeStrategyEnumAliases
  // (strategySchema.js) only run at build/revise TIME. A strategy that
  // was built/revised BEFORE this bid-strategy fix shipped and has sat
  // in 'proposed' since (a real live scenario — the same conversation
  // gets reused across many testing rounds) carries its stale
  // LOWEST_COST_WITH_BID_CAP/COST_CAP value forever, since nothing
  // re-touches an already-stored row until its NEXT build/revise call.
  // The schema now only allows LOWEST_COST_WITHOUT_CAP at all, so any
  // other stored value is unconditionally stale — safe to correct right
  // here, at the one place that actually spends real API calls, rather
  // than let an old row's zombie enum value reach Meta's real API again.
  const safeBidStrategy = strategy.bid_strategy === "LOWEST_COST_WITHOUT_CAP" ? strategy.bid_strategy : "LOWEST_COST_WITHOUT_CAP";
  // Live bug (round 31): approval/budget/Pixel all worked and the request
  // reached Meta, which then rejected it: "Bid amount required... For
  // LOWEST_COST_WITH_BID_CAP you must provide bid_amount... For TARGET_COST
  // you must provide bid_amount..." (Meta error 100/1815857) — even though
  // bid_strategy sent on the ad set below was always LOWEST_COST_WITHOUT_
  // CAP (see safeBidStrategy above), which needs no bid_amount at all. Root
  // cause: the campaign below ALSO carried its own daily_budget, which is
  // what turns on Meta's Campaign Budget Optimization (CBO) — and under
  // CBO, bid_strategy belongs on the CAMPAIGN, not the ad set; Meta ignores
  // whatever bid_strategy an ad set sends in that mode. Since this campaign
  // was never given a bid_strategy of its own, Meta fell back to a capped
  // default at the campaign level with no bid_amount behind it — hence the
  // error, regardless of what the ad set said. Every strategy this executor
  // builds is exactly one ad set per campaign (Step 8/9), so there is no
  // reason to run CBO at all: budget now lives ONLY on the ad set (Ad Set
  // Budget Optimization/ABO), which is where bid_strategy already is —
  // eliminating the CBO/ABO mismatch rather than trying to keep both
  // budget levels and both bid_strategy locations in sync.
  // Live bug (round 31, second recurrence): with CBO genuinely off (no
  // campaign-level daily_budget — confirmed: the bid_amount error is gone,
  // replaced by a DIFFERENT one), Meta now requires
  // is_adset_budget_sharing_enabled to be explicitly declared: "You must
  // specify True or False in the field is_adset_budget_sharing_enabled if
  // you are not using campaign budget... Passing in True will enable your
  // ad sets to share 20% of their budget to optimize overall performance"
  // (Meta error 100/4834011). Explicitly false — each ad set's approved
  // budget must stay exactly what was approved; Meta reallocating a slice
  // of it on its own is exactly the kind of silent-drift a real spend
  // decision must never be subject to unasked.
  const campaignParams = { name: `${strategy.business_goal} — ${strategy.recommended_objective}`, objective: strategy.recommended_objective, status: "PAUSED", isAdsetBudgetSharingEnabled: false };
  // Diagnostic logging (round 31 live bug: the identical Meta error
  // 100/1815857 recurred after the CBO/ABO fix above was deployed, because
  // that fix hadn't actually been deployed yet — see round 31's follow-up
  // commits) — the NEXT live attempt needs real evidence instead of
  // another guess. campaignRequestBody mirrors meta.createCampaign's own
  // body construction exactly (api.js adds special_ad_categories: [] and
  // renames dailyBudget -> daily_budget/isAdsetBudgetSharingEnabled ->
  // is_adset_budget_sharing_enabled; there is no dailyBudget key in
  // campaignParams at all, so no daily_budget reaches this request) —
  // this is genuinely what leaves the server, not an approximation.
  // meta.createAdSet passes its fields argument straight through as the
  // body with no renaming, so adSetParams below IS the real request body.
  // Always-on (not gated by META_EXPERT_V2_TRACE) since this is the one
  // call path that spends real money and needs to be diagnosable from
  // production logs on the very next attempt, not just when tracing is
  // deliberately turned on beforehand.
  const campaignRequestBody = { name: campaignParams.name, objective: campaignParams.objective, status: campaignParams.status, is_adset_budget_sharing_enabled: campaignParams.isAdsetBudgetSharingEnabled, special_ad_categories: [] };
  logger.info("meta_expert_v2.execute_strategy.campaign_request", { strategyId: stored.id, adAccountId: resolvedAssets.adAccountId, body: campaignRequestBody });
  const campaign = await meta.createCampaign(accessToken, resolvedAssets.adAccountId, campaignParams);
  logger.info("meta_expert_v2.execute_strategy.campaign_response", { strategyId: stored.id, campaign });

  const adSetParams = {
    name: `${strategy.business_goal} — ad set`,
    campaign_id: campaign.id,
    daily_budget: minorUnitBudget,
    billing_event: "IMPRESSIONS",
    ...buildOptimizationFields(strategy, resolvedAssets.pixelId),
    bid_strategy: safeBidStrategy,
    targeting,
    status: "PAUSED",
  };
  logger.info("meta_expert_v2.execute_strategy.adset_request", { strategyId: stored.id, adAccountId: resolvedAssets.adAccountId, body: adSetParams });
  // Live gap (round 31): the campaign above is created FIRST — if this ad
  // set creation then fails (exactly what the bid_amount rejection does),
  // nothing previously cleaned it up. A real, empty, PAUSED campaign was
  // left behind on the actual ad account on every single failed attempt —
  // never spending money by itself, but a genuine orphan accumulating with
  // every retry during live testing. Best-effort: on any failure past this
  // point, delete the campaign we just created before rethrowing the
  // original error (never masking it with a cleanup failure) — a cleanup
  // failure is logged, not thrown, since the customer needs the REAL
  // reason execution failed, not a secondary cleanup problem.
  // Live gap (this feature): the ad set above was the last step before —
  // now the creative/ad attach (attachCampaignCreative) runs too, and a
  // failure THERE is exactly as orphan-prone as an ad-set failure (a real
  // campaign + ad set left behind, no ad ever attached). Both now share
  // this ONE try block and the SAME cleanup on any failure past this
  // point, rather than only guarding the ad set creation.
  let adSet;
  let creativeResult;
  try {
    adSet = await meta.createAdSet(accessToken, resolvedAssets.adAccountId, adSetParams);
    logger.info("meta_expert_v2.execute_strategy.adset_response", { strategyId: stored.id, adSet });
    creativeResult = await attachCampaignCreative(stored, accessToken, resolvedAssets.adAccountId, adSet.id, campaign.id, resolvedAssets.pageId);
  } catch (err) {
    try {
      await meta.setCampaignStatus(accessToken, campaign.id, "DELETED");
      logger.warn("meta_expert_v2.execute_strategy.orphaned_campaign_cleaned_up", { strategyId: stored.id, campaignId: campaign.id });
    } catch (cleanupErr) {
      logger.error("meta_expert_v2.execute_strategy.orphaned_campaign_cleanup_failed", { strategyId: stored.id, campaignId: campaign.id, cleanupError: cleanupErr.message });
    }
    throw err;
  }

  const executionResult = {
    campaignId: campaign.id, adSetId: adSet.id, adAccountId: resolvedAssets.adAccountId, pageId: resolvedAssets.pageId, status: "PAUSED",
    adId: creativeResult.adId, creativeId: creativeResult.creativeId, creativeAttached: creativeResult.attached, creativeSkippedReason: creativeResult.skippedReason,
  };
  publishEvent(userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_created", campaignId: campaign.id, name: strategy.business_goal, source: "meta_expert_v2" });
  if (creativeResult.attached) {
    publishEvent(userId, "meta_ads", "meta_ads_event", { eventSubtype: "ad_created", adId: creativeResult.adId, adSetId: adSet.id, name: strategy.business_goal, source: "meta_expert_v2", format: resolvedAssets.creative?.source || null });
  }
  return executionResult;
}

// Explicit-action mode (Step 10) — a lightweight campaign wrapping a
// SINGLE fixed action (boost an existing post, or run an attached image/
// video) rather than a full multi-decision strategy. Still creates a real
// Campaign + Ad Set first (Meta's structure requires it), then attaches
// the actual creative via the SAME internal tools the explicit-action
// chat flow already uses — called directly, never through LLM dispatch.
// NOT converted to minor units like executeCampaignMode below — this path
// creates its campaign directly via api.js (safe to convert) but the ad
// set goes through the SHARED meta.create_ad_set tool (campaigns.js),
// which V1 also dispatches directly and which enforces its own
// assertBudgetWithinCap against MAX_EXECUTABLE_DAILY_BUDGET in MAJOR
// units — feeding it an already-converted minor-unit number would trip
// that cap falsely (e.g. 50000 minor units > a 10000-major-unit cap) or
// require changing campaigns.js itself, which is shared V1 code this
// rebuild must never touch. Left as a known, separately-flagged gap
// rather than a half-fix that trades one currency bug for a new false
// rejection.
async function executeExplicitAction(stored, accessToken, userId, conversationId) {
  const { strategy, resolvedAssets } = stored;
  const objective = strategy.recommended_objective || "OUTCOME_ENGAGEMENT";
  const campaignParams = { name: `${strategy.business_goal} — ${objective}`, objective, dailyBudget: strategy.budget_daily, status: "PAUSED" };
  // Diagnostic logging (round 31) — see executeCampaignMode's matching log
  // lines above; kept here too so a live report is distinguishable by
  // which of the two modes actually dispatched (see the dispatch log in
  // executeStrategy below), not assumed from the conversation's shape.
  logger.info("meta_expert_v2.execute_strategy.explicit_action.campaign_request", { strategyId: stored.id, adAccountId: resolvedAssets.adAccountId, body: { name: campaignParams.name, objective: campaignParams.objective, status: campaignParams.status, daily_budget: campaignParams.dailyBudget, special_ad_categories: [] } });
  const campaign = await meta.createCampaign(accessToken, resolvedAssets.adAccountId, campaignParams);
  logger.info("meta_expert_v2.execute_strategy.explicit_action.campaign_response", { strategyId: stored.id, campaign });
  // Live gap (round 31) — same orphaned-campaign risk as executeCampaignMode
  // above: the campaign is already created by this point, and everything
  // below it (the shared ad set tool, then the boost/create-image-ad call)
  // can still fail. Best-effort cleanup on any failure past this point,
  // same pattern: delete the campaign we just created, log the cleanup
  // outcome, and always rethrow the ORIGINAL error — a cleanup failure
  // must never replace the real reason execution failed.
  let adSetResult;
  let creativeResult;
  try {
    const adSetTool = getTool("meta.create_ad_set");
    const adSetToolParams = { adAccountId: resolvedAssets.adAccountId, campaignId: campaign.id, name: `${strategy.business_goal} — ad set`, dailyBudget: strategy.budget_daily, optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", countries: strategy.countries || ["PK"] };
    logger.info("meta_expert_v2.execute_strategy.explicit_action.adset_request", { strategyId: stored.id, params: adSetToolParams });
    adSetResult = await adSetTool.execute(adSetToolParams, { userId, conversationId });
    logger.info("meta_expert_v2.execute_strategy.explicit_action.adset_response", { strategyId: stored.id, adSetResult });

    if (strategy.action_type === "BOOST_FACEBOOK_POST") {
      creativeResult = await getTool("meta.boost_post").execute(
        { adAccountId: resolvedAssets.adAccountId, adSetId: adSetResult.adSetId, name: strategy.business_goal, postId: resolvedAssets.contentId },
        { userId, conversationId }
      );
    } else if (strategy.action_type === "BOOST_INSTAGRAM_POST") {
      creativeResult = await getTool("meta.boost_post").execute(
        { adAccountId: resolvedAssets.adAccountId, adSetId: adSetResult.adSetId, name: strategy.business_goal, instagramMediaId: resolvedAssets.contentId, pageId: resolvedAssets.pageId },
        { userId, conversationId }
      );
    } else if (strategy.action_type === "USE_ATTACHED_IMAGE") {
      creativeResult = await getTool("meta.create_image_ad").execute(
        {
          adAccountId: resolvedAssets.adAccountId, adSetId: adSetResult.adSetId, pageId: resolvedAssets.pageId, name: strategy.business_goal,
          imageReferenceId: resolvedAssets.contentId, primaryText: strategy.reasoning_summary, headline: strategy.business_goal, link: "",
        },
        { userId, conversationId }
      );
    } else {
      const err = new Error(`Explicit action type "${strategy.action_type}" is not yet supported for execution.`);
      err.code = "META_V2_ACTION_NOT_SUPPORTED";
      throw err;
    }
  } catch (err) {
    try {
      await meta.setCampaignStatus(accessToken, campaign.id, "DELETED");
      logger.warn("meta_expert_v2.execute_strategy.orphaned_campaign_cleaned_up", { strategyId: stored.id, campaignId: campaign.id });
    } catch (cleanupErr) {
      logger.error("meta_expert_v2.execute_strategy.orphaned_campaign_cleanup_failed", { strategyId: stored.id, campaignId: campaign.id, cleanupError: cleanupErr.message });
    }
    throw err;
  }

  const executionResult = { campaignId: campaign.id, adSetId: adSetResult.adSetId, adId: creativeResult.adId, adAccountId: resolvedAssets.adAccountId, pageId: resolvedAssets.pageId, status: "PAUSED" };
  publishEvent(userId, "meta_ads", "meta_ads_event", { eventSubtype: "ad_created", adId: creativeResult.adId, name: strategy.business_goal, source: "meta_expert_v2", format: "explicit_action" });
  return executionResult;
}

export async function executeStrategy({ userId, conversationId, accessToken, strategyId }) {
  // Runtime kill switch, checked FIRST and again here (defense in depth —
  // the tool wrapper in server/tools/meta/metaExpertV2.js already checks
  // this too) — this is the one call that spends real ad budget, so
  // "already installed" or "already approved" must never be a way around
  // the flag being off right now.
  assertV2RuntimeEnabled(userId);
  const stored = loadExecutable(userId, conversationId, strategyId);

  // Defense in depth — checkV2ExecutionApprovalGate in orchestrator/
  // index.js already blocks this before the tool is even dispatched, but
  // budget_daily is legitimately nullable at build time (schema allows it
  // — "Null if a budget policy/user input is still needed") and this
  // function is also reachable directly (see the kill-switch comment
  // above). Meta's real Ad Set creation has no such flexibility — a null
  // budget reaches Meta's API and comes back as a raw "(#100) Invalid
  // parameter" the customer would otherwise see verbatim.
  const dailyBudgetAtExecution = stored.strategy.budget_daily;
  if (typeof dailyBudgetAtExecution !== "number" || dailyBudgetAtExecution <= 0) {
    const err = new Error("This strategy has no daily budget set — a real budget is required before it can be executed. Build a revised strategy with a budget_daily set.");
    err.code = "META_V2_BUDGET_MISSING";
    throw err;
  }

  // Defense in depth — budget policy is already checked at build time, but
  // a strategy can sit in 'proposed' for a while and the configured
  // maximum could be lowered in between.
  if (dailyBudgetAtExecution > MAX_EXECUTABLE_DAILY_BUDGET) {
    const err = new Error(`This strategy's daily budget (${dailyBudgetAtExecution}) exceeds the current maximum executable daily budget (${MAX_EXECUTABLE_DAILY_BUDGET}) — it cannot be executed as-is. Build a revised strategy with a lower budget.`);
    err.code = "META_V2_BUDGET_LIMIT_EXCEEDED";
    throw err;
  }

  // Defense in depth — checkV2ExecutionApprovalGate in orchestrator/
  // index.js already blocks this before the tool is even dispatched (same
  // reasoning as the budget checks above: this function is also reachable
  // directly). A real unresolved_questions entry (e.g. an ambiguous Pixel
  // with no default — strategyBuilder.js) means resolvedAssets is
  // genuinely incomplete (pixelId null); executing anyway reaches Meta
  // with a broken promoted_object and a confusing rejection instead of
  // this clear one.
  if (Array.isArray(stored.strategy.unresolved_questions) && stored.strategy.unresolved_questions.length > 0) {
    const err = new Error(`This strategy still has an unresolved question: "${stored.strategy.unresolved_questions[0]}" — build a revised strategy answering it before executing.`);
    err.code = "META_V2_UNRESOLVED_QUESTION";
    throw err;
  }

  markStrategyApproved(stored.id);

  try {
    setStrategyStatus(stored.id, "executing");

    // Re-verify the resolved ids are STILL valid right before spending
    // anything real — time may have passed since the strategy was
    // proposed, access can be revoked in between (Step 8, requirement 2).
    const [adAccounts, pages] = await Promise.all([meta.listAdAccounts(accessToken), meta.listPages(accessToken)]);
    const adAccount = adAccounts.find((a) => a.id === stored.resolvedAssets.adAccountId);
    if (!adAccount) {
      throw new Error(`The ad account this strategy was built for (${stored.resolvedAssets.adAccountId}) is no longer connected — build a new strategy.`);
    }
    if (!pages.some((p) => p.id === stored.resolvedAssets.pageId)) {
      throw new Error(`The Facebook Page this strategy was built for (${stored.resolvedAssets.pageId}) is no longer connected — build a new strategy.`);
    }

    // Hard guard (round 30): the currency this strategy was built/revised
    // against (captured at that time — see assetResolution.js) must still
    // match the ad account's REAL currency right now. executeCampaignMode
    // below already always converts using the FRESH currency fetched here,
    // so the actual Meta charge is never wrong on its own — but a mismatch
    // between what the strategy was built for and what's about to be
    // charged is exactly the class of silent-drift bug that must never
    // reach a real spend decision unexamined (an ad account's billing
    // currency changing between build and execution is rare but real).
    // Skipped only for a strategy stored before this fix shipped (no
    // captured currency to compare against at all) — silently allowed to
    // proceed, not blocked, since blocking retroactively would brick every
    // already-approved strategy with no way to fix itself.
    const builtForCurrency = stored.resolvedAssets.adAccountCurrency;
    if (builtForCurrency && builtForCurrency !== adAccount.currency) {
      throw new Error(`This strategy was built for a ${builtForCurrency} ad account, but the ad account's real currency is now ${adAccount.currency} — refusing to execute rather than risk spending the wrong amount. Build a new strategy to pick up the current currency.`);
    }

    // Diagnostic logging (round 31) — which branch actually ran, so a live
    // report can be checked against the real dispatch instead of assumed.
    logger.info("meta_expert_v2.execute_strategy.dispatch", { strategyId: stored.id, mode: stored.mode, adAccountId: stored.resolvedAssets.adAccountId, adAccountCurrency: adAccount.currency });
    const executionResult = stored.mode === "explicit_action"
      ? await executeExplicitAction(stored, accessToken, userId, conversationId)
      : await executeCampaignMode(stored, accessToken, userId, adAccount.currency);

    markStrategyExecuted(stored.id, executionResult);
    // Honest, mode/attach-aware nextStep — never claims an ad exists when
    // creativeAttached is explicitly false (the exact "false completion
    // claim" class of bug this whole feature exists to avoid repeating).
    const nextStep = executionResult.adId
      ? "Campaign, ad set, and ad are created and PAUSED — nothing will spend until you resume it."
      : `Campaign and ad set are created and PAUSED — no ad was attached yet.${executionResult.creativeSkippedReason ? ` ${executionResult.creativeSkippedReason}` : ""}`;
    return { ...executionResult, nextStep };
  } catch (err) {
    // Live bug: Meta's real Ad Set creation rejected an approved strategy
    // with "(#100/3858558) To avoid zero results, your budget must be at
    // least PKR250.00" — a genuinely recoverable, budget-only problem
    // Meta itself already quantified. markStrategyFailed below moves the
    // strategy out of EXECUTABLE_STATUSES entirely, so
    // getActiveStrategyForConversation would no longer find it — forcing
    // the user back through a full build_strategy from scratch just to
    // raise one number. For this specific, identifiable Meta rejection,
    // keep the strategy 'proposed' instead so a plain "revise the budget
    // to X" reaches it through the normal revise_strategy path.
    if (err.code === 100 && err.subcode === 3858558) {
      setStrategyStatus(stored.id, "proposed");
      throw err;
    }
    markStrategyFailed(stored.id, err.message);
    throw err;
  }
}

export function rejectStrategy(userId, conversationId, strategyId) {
  const stored = strategyId ? getStoredStrategy(userId, strategyId) : getActiveStrategyForConversation(userId, conversationId);
  if (stored) markStrategyRejected(stored.id);
}
