// Meta Ads Expert planner — Phase 1. Wires server/agents/metaExpert/ into
// the same tool-registry + approval mechanism every other Meta tool
// already uses (Step 8: orchestrate the existing tools, don't replace
// them). Three tools, forming the flow from the spec:
//   research_business_context -> create_campaign_plan -> (user approves
//   in chat) -> execute_campaign_plan (requiresConfirmation: true, same
//   as every other Meta write tool — the existing Approve/Reject UI is
//   the final gate before anything real happens).
import { registerTool } from "../registry.js";
import { registerOnRejectedHandler } from "../../orchestrator/executor.js";
import { requireValidToken } from "../../integrations/manager.js";
import * as meta from "../../integrations/meta/api.js";
import { publishEvent } from "../../automation/triggers.js";
import { gatherBusinessContext } from "../../agents/metaExpert/research.js";
import {
  createPlan, getStoredPlan, getActivePlanForConversation, setPlanStatus,
  markPlanExecuted, markPlanFailed, markPlanRejected, EXECUTABLE_STATUSES,
} from "../../agents/metaExpert/planner.js";
import { INTERNAL_PLAN_SCHEMA } from "../../agents/metaExpert/planSchema.js";
import { buildTargeting } from "./campaigns.js";

function token(context) {
  return requireValidToken(context.userId, "meta_ads");
}

// Meta's real Ad Set `optimization_goal` enum does NOT include "PURCHASE"
// (or any of this plan's other custom-event-style optimization_event
// values except the ones that ARE also real Meta enum values, like
// LINK_CLICKS/REACH/etc.) — confirmed as the likely cause of a live
// "(#100) Invalid parameter" failure. Conversion events (Purchase, Add to
// Cart, Lead, Complete Registration) are optimized via
// optimization_goal: "OFFSITE_CONVERSIONS" plus a `promoted_object`
// naming the Pixel and which specific event to optimize for — Meta's own
// real mechanism, not this app's internal enum name. Every other
// optimization_event value in the schema already matches a real Meta
// optimization_goal value directly, so no mapping is needed for those.
const CONVERSION_EVENT_TO_META_GOAL = {
  PURCHASE: "OFFSITE_CONVERSIONS",
  ADD_TO_CART: "OFFSITE_CONVERSIONS",
  LEAD: "OFFSITE_CONVERSIONS",
  COMPLETE_REGISTRATION: "OFFSITE_CONVERSIONS",
};

function buildOptimizationFields(plan, resolvedPixelId) {
  const metaGoal = CONVERSION_EVENT_TO_META_GOAL[plan.optimization_event];
  if (!metaGoal) return { optimization_goal: plan.optimization_event };
  return {
    optimization_goal: metaGoal,
    promoted_object: { pixel_id: resolvedPixelId, custom_event_type: plan.optimization_event },
  };
}

registerTool({
  name: "meta_expert.research_business_context",
  description:
    "Gathers real, current business and Meta account context (commerce platform + products, ad accounts, Pages, Instagram, Pixels, catalogs, existing campaigns, historical performance, recent posts) before proposing a campaign plan. ALWAYS call this before meta_expert.create_campaign_plan when the user states a goal (e.g. 'I want more website sales') rather than an explicit action — never invent business facts. Returns knownFacts (confirmed from a real API call), inferredFacts (derived from known facts, with what they were inferred from), and unavailable (sources that couldn't be reached, with why — not connected is a normal, expected state, not a failure).",
  category: "meta_expert",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    return gatherBusinessContext(context.userId);
  },
});

// The plan schema is exposed as a tool so the model can see the exact
// contract (required fields, enums) directly from its own tool
// definition — the same "the tool's parameters ARE the schema" idea Step
// 2 describes, with the added benefit that registry.js's own required-
// field check (server/tools/registry.js's validateParameters) already
// enforces top-level required-ness before execute() even runs, and
// execute() below re-validates everything in full including field-level
// rules (enums, age ordering, etc.) that a simple required-field check
// can't express.
registerTool({
  name: "meta_expert.create_campaign_plan",
  description:
    "Creates and validates an internal Meta campaign plan from the business/account context already researched (call meta_expert.research_business_context first). This does NOT create anything in Meta — it's a validated, stored proposal that gets presented to the user for approval before meta_expert.execute_campaign_plan ever runs. Reference assets SEMANTICALLY — facebook_page.ref / ad_account.ref / pixel.ref / catalog.ref should be \"default_facebook_page\" / \"default_ad_account\" / \"default_pixel\" / \"default_catalog\" unless the user already specified a particular real one (a real id already confirmed via a lookup tool this conversation — NEVER an invented id). campaign_status must always be \"PAUSED\". If validation fails, the response lists exactly what's wrong — fix the plan and call this again, don't guess around it. Full field contract: " +
    JSON.stringify(INTERNAL_PLAN_SCHEMA.required),
  category: "meta_expert",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The user's own stated goal, in their words." },
      objective: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.objective.enum },
      conversion_location: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.conversion_location.enum },
      optimization_event: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.optimization_event.enum },
      targeting_strategy: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.targeting_strategy.enum },
      age_min: { type: "number" },
      age_max: { type: "number" },
      gender: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.gender.enum },
      locations: { type: "array", items: { type: "string" }, description: "Human-readable place names for display, e.g. [\"Karachi\", \"Lahore\"]." },
      countries: { type: "array", items: { type: "string" }, description: "ISO 3166-1 alpha-2 country codes, e.g. [\"PK\"] — what real Meta targeting is actually built from." },
      placements: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.placements.enum },
      manual_placements: { type: "array", items: { type: "string" } },
      creative_strategy: {
        type: "object",
        properties: {
          source: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.creative_strategy.properties.source.enum },
          description: { type: "string" },
        },
      },
      budget_strategy: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.budget_strategy.enum },
      daily_budget: { type: "number", description: "In the ad account's currency's smallest unit. Omit (leave unset) if a budget policy/user input is still needed — don't invent a number." },
      bid_strategy: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.bid_strategy.enum },
      facebook_page: { type: "object", properties: { ref: { type: "string" } } },
      instagram_identity: { type: ["object", "null"], properties: { ref: { type: "string" } } },
      ad_account: { type: "object", properties: { ref: { type: "string" } } },
      pixel: { type: ["object", "null"], properties: { ref: { type: "string" } } },
      catalog: { type: ["object", "null"], properties: { ref: { type: "string" } } },
      cta: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.cta.enum },
      campaign_status: { type: "string", enum: ["PAUSED"] },
      assumptions: { type: "array", items: { type: "string" } },
      reasoning_summary: { type: "string" },
      confidence: { type: "string", enum: INTERNAL_PLAN_SCHEMA.properties.confidence.enum },
      approval_required: { type: "boolean" },
      open_questions: { type: "array", items: { type: "string" } },
      revisesPlanId: {
        type: "string",
        description: "Optional — set this to an existing proposed plan's id when this call is a REVISION of it (e.g. the user asked to change the audience or budget), not a brand-new campaign concept. Carries the prior daily_budget forward automatically if this call doesn't set one, per 'preserve the approved budget unless the change requires otherwise.' Omit for a genuinely new campaign.",
      },
    },
    required: INTERNAL_PLAN_SCHEMA.required,
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false, // Nothing external happens yet — this only validates + stores a proposal.
  async execute(parameters, context) {
    const accessToken = token(context);
    const { revisesPlanId, ...plan } = parameters;
    const result = await createPlan({ userId: context.userId, conversationId: context.conversationId, accessToken, plan, revisesPlanId });
    if (!result.ok) {
      return { valid: false, errors: result.errors };
    }
    return { valid: true, planId: result.planId, recommendationText: result.recommendationText };
  },
});

registerTool({
  name: "meta_expert.execute_campaign_plan",
  description:
    "Executes a previously created and user-approved campaign plan (from meta_expert.create_campaign_plan) — creates the real Meta Campaign and Ad Set, both PAUSED. Only call this after the user has explicitly approved the recommendation in chat, and only with a planId meta_expert.create_campaign_plan returned EARLIER IN THIS SAME CONVERSATION — never a remembered/guessed id from a different conversation or an old test. planId is optional: omit it to use the current active plan for this conversation automatically. If this fails with META_PLAN_REQUIRED, that means there is no valid current plan to execute — call meta_expert.create_campaign_plan first (after research_business_context if you haven't already), present the recommendation, and only call this again once the user approves that. Never retry this tool with a different/older planId to work around the error. Phase 1 builds the Campaign + Ad Set structure only — attaching the final creative/ad is the next step, either using the existing meta.create_image_ad / meta.boost_post / meta.create_video_ad tools against the returned adSetId, or Phase 2's creative intelligence once that's built.",
  category: "meta_expert",
  parameters: { type: "object", properties: { planId: { type: "string", description: "Optional — omit to use the current active plan for this conversation." } }, required: [] },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // The one real Meta mutation in this flow — same approval gate every other write tool uses.
  async execute(parameters, context) {
    let stored = parameters.planId ? getStoredPlan(context.userId, parameters.planId) : null;
    if (!parameters.planId) {
      stored = getActivePlanForConversation(context.userId, context.conversationId);
    }

    if (!stored) {
      const err = new Error(
        parameters.planId
          ? `No plan found with id "${parameters.planId}" for this account.`
          : "No current campaign plan exists for this conversation."
      );
      err.code = "META_PLAN_REQUIRED";
      throw err;
    }

    // A planId belonging to a DIFFERENT conversation is the exact shape of
    // bug confirmed live: an old/stale/hallucinated id getting executed
    // for an unrelated request. Reject rather than trust it — a plan is
    // only ever "the intended plan" for the conversation it was proposed
    // in, unless the caller supplies no id at all (in which case
    // getActivePlanForConversation already scoped it correctly above).
    if (parameters.planId && stored.conversationId && context.conversationId && stored.conversationId !== context.conversationId) {
      const err = new Error(`Plan "${parameters.planId}" belongs to a different conversation, not this one — it can't be executed here.`);
      err.code = "META_PLAN_REQUIRED";
      throw err;
    }

    if (!EXECUTABLE_STATUSES.has(stored.status)) {
      const err = new Error(
        stored.status === "executed"
          ? "This plan has already been executed — create a new plan for another campaign."
          : `This plan is no longer active (status: ${stored.status}) — create a new plan.`
      );
      err.code = "META_PLAN_REQUIRED";
      throw err;
    }

    setPlanStatus(stored.id, "approved");

    const accessToken = token(context);
    const { plan, resolved } = stored.planData;

    try {
      setPlanStatus(stored.id, "executing");

      // Defense in depth: re-verify the resolved ids are STILL valid right
      // before spending anything real — time may have passed since the
      // plan was proposed, and access can be revoked in between.
      const [adAccounts, pages] = await Promise.all([meta.listAdAccounts(accessToken), meta.listPages(accessToken)]);
      if (!adAccounts.some((a) => a.id === resolved.adAccountId)) {
        throw new Error(`The ad account this plan was built for (${resolved.adAccountId}) is no longer connected — create a new plan.`);
      }
      if (!pages.some((p) => p.id === resolved.pageId)) {
        throw new Error(`The Facebook Page this plan was built for (${resolved.pageId}) is no longer connected — create a new plan.`);
      }

      const campaign = await meta.createCampaign(accessToken, resolved.adAccountId, {
        name: `${plan.goal} — ${plan.objective}`,
        objective: plan.objective,
        dailyBudget: plan.daily_budget,
        status: "PAUSED",
      });

      const adSet = await meta.createAdSet(accessToken, resolved.adAccountId, {
        name: `${plan.goal} — ad set`,
        campaign_id: campaign.id,
        daily_budget: plan.daily_budget,
        billing_event: "IMPRESSIONS",
        ...buildOptimizationFields(plan, resolved.pixelId),
        bid_strategy: plan.bid_strategy,
        targeting: buildTargeting({ countries: plan.countries, ageMin: plan.age_min, ageMax: plan.age_max, gender: plan.gender === "ALL" ? undefined : plan.gender?.toLowerCase() }),
        status: "PAUSED",
      });

      const executionResult = { campaignId: campaign.id, adSetId: adSet.id, adAccountId: resolved.adAccountId, pageId: resolved.pageId, status: "PAUSED" };
      markPlanExecuted(stored.id, executionResult);
      publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_created", campaignId: campaign.id, name: plan.goal, source: "meta_expert" });

      return {
        ...executionResult,
        nextStep: "Campaign and ad set are created and PAUSED. Attach a creative next — either an existing post (meta.boost_post), a product/generated image (meta.create_image_ad), or a video (meta.upload_ad_video + meta.create_video_ad) — using this adSetId, adAccountId, and pageId.",
      };
    } catch (err) {
      markPlanFailed(stored.id, err.message);
      throw err;
    }
  },
});

// See executor.js's registerOnRejectedHandler — when the user declines the
// approval prompt for this specific tool, the plan is marked 'rejected'
// rather than left dangling in 'proposed' (which getActivePlanForConversation
// would otherwise keep treating as the active plan for this conversation).
registerOnRejectedHandler("meta_expert.execute_campaign_plan", async (parameters, { userId, conversationId }) => {
  const stored = parameters.planId ? getStoredPlan(userId, parameters.planId) : getActivePlanForConversation(userId, conversationId);
  if (stored) markPlanRejected(stored.id);
});
