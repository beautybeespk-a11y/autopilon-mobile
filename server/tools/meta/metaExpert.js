// Meta Ads Expert planner — Phase 1. Wires server/agents/metaExpert/ into
// the same tool-registry + approval mechanism every other Meta tool
// already uses (Step 8: orchestrate the existing tools, don't replace
// them). Three tools, forming the flow from the spec:
//   research_business_context -> create_campaign_plan -> (user approves
//   in chat) -> execute_campaign_plan (requiresConfirmation: true, same
//   as every other Meta write tool — the existing Approve/Reject UI is
//   the final gate before anything real happens).
import { registerTool } from "../registry.js";
import { requireValidToken } from "../../integrations/manager.js";
import * as meta from "../../integrations/meta/api.js";
import { publishEvent } from "../../automation/triggers.js";
import { gatherBusinessContext } from "../../agents/metaExpert/research.js";
import { createPlan, getStoredPlan, markPlanExecuted } from "../../agents/metaExpert/planner.js";
import { INTERNAL_PLAN_SCHEMA } from "../../agents/metaExpert/planSchema.js";
import { buildTargeting } from "./campaigns.js";

function token(context) {
  return requireValidToken(context.userId, "meta_ads");
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
    },
    required: INTERNAL_PLAN_SCHEMA.required,
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false, // Nothing external happens yet — this only validates + stores a proposal.
  async execute(parameters, context) {
    const accessToken = token(context);
    const plan = { ...parameters };
    const result = await createPlan({ userId: context.userId, accessToken, plan });
    if (!result.ok) {
      return { valid: false, errors: result.errors };
    }
    return { valid: true, planId: result.planId, recommendationText: result.recommendationText };
  },
});

registerTool({
  name: "meta_expert.execute_campaign_plan",
  description:
    "Executes a previously created and user-approved campaign plan (from meta_expert.create_campaign_plan) — creates the real Meta Campaign and Ad Set, both PAUSED. Only call this after the user has explicitly approved the recommendation in chat. Phase 1 builds the Campaign + Ad Set structure only (country-level targeting, budget, objective) — attaching the final creative/ad (the specific image, video, or boosted post) is the next step, either using the existing meta.create_image_ad / meta.boost_post / meta.create_video_ad tools against the returned adSetId, or Phase 2's creative intelligence once that's built.",
  category: "meta_expert",
  parameters: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // The one real Meta mutation in this flow — same approval gate every other write tool uses.
  async execute(parameters, context) {
    const stored = getStoredPlan(context.userId, parameters.planId);
    if (!stored) throw new Error(`No plan found with id "${parameters.planId}" for this account.`);
    if (stored.status === "executed") throw new Error("This plan has already been executed — create a new plan for another campaign.");

    const accessToken = token(context);
    const { plan, resolved } = stored.planData;

    // Defense in depth: re-verify the resolved ids are STILL valid right
    // before spending anything real — time may have passed since the plan
    // was proposed, and access can be revoked in between.
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
      optimization_goal: plan.optimization_event,
      bid_strategy: plan.bid_strategy,
      targeting: buildTargeting({ countries: plan.countries, ageMin: plan.age_min, ageMax: plan.age_max, gender: plan.gender === "ALL" ? undefined : plan.gender?.toLowerCase() }),
      status: "PAUSED",
    });

    const executionResult = { campaignId: campaign.id, adSetId: adSet.id, adAccountId: resolved.adAccountId, pageId: resolved.pageId, status: "PAUSED" };
    markPlanExecuted(parameters.planId, executionResult);
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_created", campaignId: campaign.id, name: plan.goal, source: "meta_expert" });

    return {
      ...executionResult,
      nextStep: "Campaign and ad set are created and PAUSED. Attach a creative next — either an existing post (meta.boost_post), a product/generated image (meta.create_image_ad), or a video (meta.upload_ad_video + meta.create_video_ad) — using this adSetId, adAccountId, and pageId.",
    };
  },
});
