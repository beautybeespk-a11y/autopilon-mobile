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
    targeting: buildTargeting({ countries: strategy.countries, ageMin: strategy.age_min, ageMax: strategy.age_max, gender: strategy.gender === "ALL" ? undefined : strategy.gender?.toLowerCase() }),
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
  let adSet;
  try {
    adSet = await meta.createAdSet(accessToken, resolvedAssets.adAccountId, adSetParams);
  } catch (err) {
    try {
      await meta.setCampaignStatus(accessToken, campaign.id, "DELETED");
      logger.warn("meta_expert_v2.execute_strategy.orphaned_campaign_cleaned_up", { strategyId: stored.id, campaignId: campaign.id });
    } catch (cleanupErr) {
      logger.error("meta_expert_v2.execute_strategy.orphaned_campaign_cleanup_failed", { strategyId: stored.id, campaignId: campaign.id, cleanupError: cleanupErr.message });
    }
    throw err;
  }
  logger.info("meta_expert_v2.execute_strategy.adset_response", { strategyId: stored.id, adSet });

  const executionResult = { campaignId: campaign.id, adSetId: adSet.id, adAccountId: resolvedAssets.adAccountId, pageId: resolvedAssets.pageId, status: "PAUSED" };
  publishEvent(userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_created", campaignId: campaign.id, name: strategy.business_goal, source: "meta_expert_v2" });
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
    return { ...executionResult, nextStep: "Campaign and ad set are created and PAUSED — nothing will spend until you resume it." };
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
