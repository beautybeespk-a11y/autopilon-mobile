// Meta Ads Expert V2 — the ONLY four tools this agent's LLM can see (Step
// 9). Registered under category "meta_expert_v2" — an agent installed
// from the "Meta Ads Manager V2" template (server/orchestrator/
// agentLibrary.js) has ONLY this skill enabled, never "meta_ads" (the raw
// mutation tools' category) — so listToolsForSkills() (server/tools/
// registry.js) structurally cannot return meta.create_campaign,
// meta.boost_post, etc. to this agent's model at all. Those tools remain
// fully reusable as INTERNAL backend primitives (server/agents/
// metaExpertV2/executor.js calls their own execute() functions directly),
// just never dispatched from an LLM tool call for this agent.
import { registerTool } from "../registry.js";
import { registerOnRejectedHandler } from "../../orchestrator/executor.js";
import { requireValidToken } from "../../integrations/manager.js";
import { gatherBusinessSnapshot } from "../../agents/metaExpertV2/businessSnapshot.js";
import { buildStrategy, reviseStrategy } from "../../agents/metaExpertV2/strategyBuilder.js";
import { executeStrategy, rejectStrategy } from "../../agents/metaExpertV2/executor.js";
import { getActiveStrategyForConversation } from "../../agents/metaExpertV2/strategyStore.js";
import { INTERNAL_STRATEGY_SCHEMA } from "../../agents/metaExpertV2/strategySchema.js";
import { assertV2RuntimeEnabled } from "../../agents/metaExpertV2/runtimeGate.js";

function token(context) {
  return requireValidToken(context.userId, "meta_ads");
}

registerTool({
  name: "meta_expert_v2.get_business_snapshot",
  description:
    "Gathers the CURRENT trusted Business Snapshot — real, live commerce platform data (products, categories, pricing), Meta assets (ad accounts, Pages, Pixels, catalogs, Instagram) with their saved defaults, Meta account history (campaigns, spend, ROAS/CPA/CTR when available), and recent Facebook/Instagram post content. ALWAYS call this before meta_expert_v2.build_strategy — never invent business facts, and never answer an account-specific question (Pixel connected? current budget? campaign results? which post/Reel/product is best?) from earlier conversation turns; call this again to get the CURRENT answer. Every field distinguishes a real known fact from something not_connected (normal, expected) or fetch_failed (connected, but the call itself failed) or ambiguous (more than one real option, no deterministic default) — never collapse these into a single true/false. " +
    "recentContent.facebookPosts/instagramPosts each contain items with: id, platform, contentType (reel/video/image/carousel/link_share/unknown — read off real media data, never guessed), captionExcerpt, publishedDate, permalink, mediaType, engagement ({status:'exists', likes/comments/shares} only when the platform actually returned real counts, else {status:'unavailable'}), reachImpressions and videoViews (always {status:'unavailable'} in this version — never actually fetched, so never claim a reach/impressions/view number), linkedProduct (a real WooCommerce/Shopify product whose name literally appears in the caption — null if none matched, never guessed), and eligibleForPromotion (a real permalink exists). " +
    "When selecting or describing specific creative (a Reel, post, or product) for an ad: NEVER invent a publication date, engagement level, ROAS/CPA, \"high performing\"/\"proven effectiveness\" framing, content format, linked product, or trend position that isn't literally present in this data. If engagement.status is 'unavailable' for the content you're selecting, you may NOT call it high-performing or proven — say so plainly and choose based on clearly-labeled factors instead (recency, product relevance, format suitability, promotional clarity, offer strength, visual/video availability), phrased as \"Based on content relevance and format...\", never \"This is your highest-performing post.\" If engagement.status is 'exists', you may cite the real numbers.",
  category: "meta_expert_v2",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    assertV2RuntimeEnabled(context.userId);
    return gatherBusinessSnapshot(context.userId);
  },
});

// The strategy schema is exposed as this tool's own parameters — same "the
// tool's parameters ARE the schema" idea the original planner used, one
// generation attempt only (Step 7: no repair-retry loop). Reference
// assets SEMANTICALLY ("default_ad_account", "default_facebook_page",
// "default_pixel", "default_catalog") unless the user already specified a
// real one this conversation.
registerTool({
  name: "meta_expert_v2.build_strategy",
  description:
    "Builds and validates a NEW Meta Ads strategy from the business snapshot already gathered (call meta_expert_v2.get_business_snapshot first). This does NOT create anything in Meta — it's a validated, stored recommendation presented to the user for approval before meta_expert_v2.execute_strategy ever runs. You get exactly ONE attempt: the backend automatically normalizes harmless issues (enum spelling drift, a missing CTA, an over-cap heuristic budget) before validating, so if this still returns valid:false, that's a genuine unresolved business issue (not something to retry with a guess) — present the returned issue to the user in plain language and wait for their answer instead of calling this again for the same request. Set mode to \"explicit_action\" for a single fixed action (\"boost my latest reel\", \"use this photo as an ad\") instead of a full campaign strategy — in that mode only business_goal/action_type/content_selector/budget fields matter; audience/placements/creative_strategy are not required. Asset fields (ad_account/facebook_page/pixel/catalog/instagram_identity) are semantic refs the backend resolves automatically (saved default, or the single connected one) — a REAL id is only ever honored as the user's explicit choice when its field name is also listed in explicitAssetChanges. Full field contract: " +
    JSON.stringify(INTERNAL_STRATEGY_SCHEMA.required),
  category: "meta_expert_v2",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["campaign", "explicit_action"], description: "Defaults to \"campaign\" if omitted." },
      business_goal: { type: "string" },
      goal_alignment: {
        type: "object",
        description: "Required whenever the literal request and the likely real business outcome could genuinely differ (e.g. user says 'traffic' but this is clearly an e-commerce business with real purchase tracking). Set recommendation_differs_from_literal_request=true and recommend the objective that actually serves the business — the backend rejects a silently-built Traffic strategy for that kind of business regardless of what you say here.",
        properties: { literal_request: { type: "string" }, likely_business_outcome: { type: "string" }, recommendation_differs_from_literal_request: { type: "boolean" } },
      },
      recommended_objective: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.recommended_objective.enum },
      optimization_event: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.optimization_event.enum },
      conversion_location: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.conversion_location.enum },
      audience_strategy: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.audience_strategy.enum, description: "What the audience was actually derived from — HEURISTIC is only honest when no real store/account data exists." },
      gender: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.gender.enum },
      age_min: { type: "number" },
      age_max: { type: "number" },
      audience_reasoning: { type: "string", description: "Required only when the audience is fully generic (all genders, 18-65)." },
      locations: { type: "array", items: { type: "string" } },
      countries: { type: "array", items: { type: "string" }, description: "ISO 3166-1 alpha-2 country codes, e.g. [\"PK\"]." },
      targeting_approach: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.targeting_approach.enum },
      placements: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.placements.enum },
      manual_placements: { type: "array", items: { type: "string" } },
      creative_strategy: { type: "object", description: "The backend rejects a description that calls content \"high performing\"/\"proven effective\" unless the selected content's real engagement data (from get_business_snapshot) actually supports it — use \"Based on content relevance and format...\" framing when no such data exists.", properties: { source: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.creative_strategy.properties.source.enum }, description: { type: "string" } } },
      budget_daily: { type: "number", description: "Omit if a budget policy/user input is still needed — never invent a number." },
      budget_basis: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.budget_basis.enum, description: "USER_PROVIDED must be genuinely stated by the user this conversation — the backend independently verifies it against their actual message text and downgrades the claim if it can't." },
      bid_strategy: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.bid_strategy.enum },
      cta: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.cta.enum },
      campaign_status: { type: "string", enum: ["PAUSED"] },
      reasoning_summary: { type: "string" },
      evidence_used: { type: "array", items: { type: "string" }, description: "Concrete facts actually pulled from the business snapshot — never a vague restatement, never a claim the snapshot didn't actually return." },
      assumptions: { type: "array", items: { type: "string" } },
      unresolved_questions: { type: "array", items: { type: "string" }, description: "Genuine unresolved BUSINESS decisions only — never a technical/asset question." },
      approval_required: { type: "boolean" },
      facebook_page: { type: "object", properties: { ref: { type: "string" } } },
      instagram_identity: { type: ["object", "null"], properties: { ref: { type: "string" } } },
      ad_account: { type: "object", properties: { ref: { type: "string" } } },
      pixel: { type: ["object", "null"], properties: { ref: { type: "string" } } },
      catalog: { type: ["object", "null"], properties: { ref: { type: "string" } } },
      action_type: { type: "string", enum: INTERNAL_STRATEGY_SCHEMA.properties.action_type.enum, description: "Only for mode \"explicit_action\"." },
      content_selector: {
        type: "object",
        description: "Only for mode \"explicit_action\". Refer to content ORDINALLY — { position: 1 } means the most recent item in the snapshot's recentContent list you already saw — never invent a raw id.",
        properties: { position: { type: "integer" }, confirmedId: { type: "string" }, attachedMediaRef: { type: "string" } },
      },
      explicitAssetChanges: {
        type: "array",
        items: { type: "string", enum: ["ad_account", "facebook_page", "pixel", "catalog", "instagram_identity"] },
        description: "List an asset field here ONLY when the user's OWN words this turn explicitly asked to use a specific real asset for that field. Never just because you happen to be setting a real id there.",
      },
    },
    required: [],
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    assertV2RuntimeEnabled(context.userId);
    const { explicitAssetChanges, ...strategy } = parameters;
    const result = await buildStrategy({ userId: context.userId, conversationId: context.conversationId, accessToken: token(context), strategy, userMessage: context.userMessage, explicitAssetChanges });
    if (!result.ok) return { valid: false, issue: result.unresolved.issue, field: result.unresolved.field };
    return { valid: true, strategyId: result.strategyId, recommendationText: result.recommendationText };
  },
});

registerTool({
  name: "meta_expert_v2.revise_strategy",
  description:
    "Revises the active strategy for this conversation — send ONLY requestedChanges containing the fields actually changing (e.g. just { gender, age_min, age_max, audience_strategy, audience_reasoning } for an audience change). Every field you omit is carried forward automatically from the prior strategy. The backend REJECTS a revision that claims to reconsider a field but leaves its value identical to before — cosmetic prose alone never counts as a real revision. strategyId is optional (omit to revise the current active strategy for this conversation). Set freshResearchRequired=true only when the change genuinely needs new facts (the user asked you to re-check WooCommerce/Meta data) — most revisions (narrower audience, different budget) don't need it. Asset fields are protected even more strictly here: they are reused from the prior strategy's ALREADY-RESOLVED real ids unless the user explicitly asked to change that specific asset AND you list it in explicitAssetChanges.",
  category: "meta_expert_v2",
  parameters: {
    type: "object",
    properties: {
      strategyId: { type: "string", description: "Optional — omit to use the current active strategy for this conversation." },
      requestedChanges: { type: "object", description: "Partial strategy fields — ONLY what's actually changing this turn." },
      freshResearchRequired: { type: "boolean" },
      explicitAssetChanges: { type: "array", items: { type: "string", enum: ["ad_account", "facebook_page", "pixel", "catalog", "instagram_identity"] } },
    },
    required: [],
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    assertV2RuntimeEnabled(context.userId);
    const strategyId = parameters.strategyId || getActiveStrategyForConversation(context.userId, context.conversationId)?.id;
    if (!strategyId) {
      const err = new Error("No active strategy exists for this conversation to revise — call meta_expert_v2.build_strategy first.");
      err.code = "META_V2_STRATEGY_REQUIRED";
      throw err;
    }
    const result = await reviseStrategy({
      userId: context.userId, conversationId: context.conversationId, accessToken: token(context), strategyId,
      requestedChanges: parameters.requestedChanges || {}, freshResearchRequired: Boolean(parameters.freshResearchRequired),
      explicitAssetChanges: parameters.explicitAssetChanges, userMessage: context.userMessage,
    });
    if (!result.ok) return { valid: false, issue: result.unresolved.issue, field: result.unresolved.field };
    return { valid: true, strategyId: result.strategyId, recommendationText: result.recommendationText };
  },
});

registerTool({
  name: "meta_expert_v2.execute_strategy",
  description:
    "Executes a previously built and user-APPROVED strategy — creates the real Meta Campaign and Ad Set (or the boosted post/image ad, for an explicit action), PAUSED. NEVER the first tool you call for a request like 'create the best campaign' — that means build a strategy first and present it. Only call this after the user has EXPLICITLY approved the CURRENT strategy in their own words this turn ('approve', 'proceed', 'run it', 'yes, create it') — the backend enforces this and blocks the call before it reaches Meta otherwise. strategyId is optional — omit it to use the current active strategy for this conversation.",
  category: "meta_expert_v2",
  parameters: { type: "object", properties: { strategyId: { type: "string", description: "Optional — omit to use the current active strategy." } }, required: [] },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    // Checked here (the tool-invocation boundary) AND again inside
    // executeStrategy() itself (server/agents/metaExpertV2/executor.js) as
    // defense in depth — this is the one call that actually spends real ad
    // budget, so "the runtime flag is off" must block it from every angle,
    // not just the one the LLM happens to go through.
    assertV2RuntimeEnabled(context.userId);
    return executeStrategy({ userId: context.userId, conversationId: context.conversationId, accessToken: token(context), strategyId: parameters.strategyId });
  },
});

registerOnRejectedHandler("meta_expert_v2.execute_strategy", async (parameters, { userId, conversationId }) => {
  rejectStrategy(userId, conversationId, parameters.strategyId);
});
