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

async function executeCampaignMode(stored, accessToken, userId) {
  const { strategy, resolvedAssets } = stored;
  const campaign = await meta.createCampaign(accessToken, resolvedAssets.adAccountId, {
    name: `${strategy.business_goal} — ${strategy.recommended_objective}`,
    objective: strategy.recommended_objective,
    dailyBudget: strategy.budget_daily,
    status: "PAUSED",
  });
  const adSet = await meta.createAdSet(accessToken, resolvedAssets.adAccountId, {
    name: `${strategy.business_goal} — ad set`,
    campaign_id: campaign.id,
    daily_budget: strategy.budget_daily,
    billing_event: "IMPRESSIONS",
    ...buildOptimizationFields(strategy, resolvedAssets.pixelId),
    bid_strategy: strategy.bid_strategy,
    targeting: buildTargeting({ countries: strategy.countries, ageMin: strategy.age_min, ageMax: strategy.age_max, gender: strategy.gender === "ALL" ? undefined : strategy.gender?.toLowerCase() }),
    status: "PAUSED",
  });
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
async function executeExplicitAction(stored, accessToken, userId, conversationId) {
  const { strategy, resolvedAssets } = stored;
  const objective = strategy.recommended_objective || "OUTCOME_ENGAGEMENT";
  const campaign = await meta.createCampaign(accessToken, resolvedAssets.adAccountId, {
    name: `${strategy.business_goal} — ${objective}`,
    objective,
    dailyBudget: strategy.budget_daily,
    status: "PAUSED",
  });
  const adSetTool = getTool("meta.create_ad_set");
  const adSetResult = await adSetTool.execute(
    { adAccountId: resolvedAssets.adAccountId, campaignId: campaign.id, name: `${strategy.business_goal} — ad set`, dailyBudget: strategy.budget_daily, optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", countries: strategy.countries || ["PK"] },
    { userId, conversationId }
  );

  let creativeResult;
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
    if (!adAccounts.some((a) => a.id === stored.resolvedAssets.adAccountId)) {
      throw new Error(`The ad account this strategy was built for (${stored.resolvedAssets.adAccountId}) is no longer connected — build a new strategy.`);
    }
    if (!pages.some((p) => p.id === stored.resolvedAssets.pageId)) {
      throw new Error(`The Facebook Page this strategy was built for (${stored.resolvedAssets.pageId}) is no longer connected — build a new strategy.`);
    }

    const executionResult = stored.mode === "explicit_action"
      ? await executeExplicitAction(stored, accessToken, userId, conversationId)
      : await executeCampaignMode(stored, accessToken, userId);

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
