import db from "../../db.js";
import { cryptoRandom } from "../../middleware.js";
import * as meta from "../../integrations/meta/api.js";
import { resolvePageId } from "../../tools/shared/metaPageId.js";
import { resolveAdAccountId } from "../../tools/shared/metaAdAccountId.js";
import { resolvePixelId } from "../../tools/shared/metaPixelId.js";
import { resolveCatalogId } from "../../tools/shared/metaCatalogId.js";
import { validatePlanStructure, validatePlanAgainstContext, PURCHASE_LIKE_EVENTS } from "./planSchema.js";

const SEMANTIC_REFS = new Set(["default_ad_account", "default_facebook_page", "default_instagram_identity", "default_pixel", "default_catalog"]);

// Turns a plan's SEMANTIC asset references ("default_ad_account", or a
// real id the model already confirmed earlier this conversation) into
// real, verified Meta ids — Step 5: the LLM must never invent
// pageId/adAccountId/pixelId/catalogId/instagramAccountId, so every one of
// these goes through the same deterministic resolvers the rest of this
// app's Meta tools use (server/tools/shared/*), never trusted from the
// plan directly.
export async function resolvePlanAssets(plan, { userId, accessToken }) {
  const resolved = { adAccountId: null, pageId: null, instagramId: null, pixelId: null, catalogId: null };
  const resolutionErrors = [];

  try {
    const providedAdAccountId = SEMANTIC_REFS.has(plan.ad_account?.ref) ? undefined : plan.ad_account?.ref;
    resolved.adAccountId = await resolveAdAccountId({ userId, accessToken, providedAdAccountId });
  } catch (err) {
    resolutionErrors.push({ field: "ad_account", message: err.message, code: err.code });
  }

  try {
    const providedPageId = SEMANTIC_REFS.has(plan.facebook_page?.ref) ? undefined : plan.facebook_page?.ref;
    resolved.pageId = await resolvePageId({ accessToken, providedPageId });
  } catch (err) {
    resolutionErrors.push({ field: "facebook_page", message: err.message, code: err.code });
  }

  if (plan.instagram_identity && resolved.pageId) {
    resolved.instagramId = await meta.getInstagramAccountId(accessToken, resolved.pageId).catch(() => null);
  }

  // Attempted whenever the plan references a pixel OR the optimization
  // event needs one to be measured — not only the former. A model that
  // picks PURCHASE optimization but forgets to also set plan.pixel
  // shouldn't skip this check just because it forgot a related field;
  // validatePlanAgainstContext() enforces the actual "Pixel required for
  // this optimization_event" rule regardless of which path resolved it.
  if ((plan.pixel || PURCHASE_LIKE_EVENTS.has(plan.optimization_event)) && resolved.adAccountId) {
    try {
      const providedPixelId = !plan.pixel || SEMANTIC_REFS.has(plan.pixel.ref) ? undefined : plan.pixel.ref;
      const { pixelId } = await resolvePixelId({ accessToken, adAccountId: resolved.adAccountId, providedPixelId });
      resolved.pixelId = pixelId;
    } catch (err) {
      resolutionErrors.push({ field: "pixel", message: err.message, code: err.code });
    }
  }

  if (plan.catalog && resolved.adAccountId) {
    try {
      const providedCatalogId = SEMANTIC_REFS.has(plan.catalog.ref) ? undefined : plan.catalog.ref;
      const { catalogId } = await resolveCatalogId({ accessToken, adAccountId: resolved.adAccountId, providedCatalogId });
      resolved.catalogId = catalogId;
    } catch (err) {
      resolutionErrors.push({ field: "catalog", message: err.message, code: err.code });
    }
  }

  return { resolved, resolutionErrors };
}

// Step 7: the customer never sees raw JSON — this turns a validated,
// resolved plan into the plain-language recommendation format specified.
export function formatRecommendation(plan, names) {
  const objectiveLabel = {
    OUTCOME_SALES: "Website Purchases", OUTCOME_TRAFFIC: "Traffic", OUTCOME_LEADS: "Leads",
    OUTCOME_ENGAGEMENT: "Engagement", OUTCOME_AWARENESS: "Awareness", OUTCOME_APP_PROMOTION: "App Promotion",
  }[plan.objective] || plan.objective;
  const genderLabel = { ALL: "All genders", MALE: "Men", FEMALE: "Women" }[plan.gender] || plan.gender;
  const budgetLine = plan.daily_budget != null ? `${plan.daily_budget}/day` : "Not yet set — needs your input";
  const placementsLabel = plan.placements === "ADVANTAGE_PLUS" ? "Advantage+ (automatic)" : (plan.manual_placements || []).join(", ");

  const lines = [
    `Based on your store, Meta account, and available business data, I recommend:`,
    ``,
    `Goal: ${objectiveLabel}`,
    `Audience: ${genderLabel} ${plan.age_min}–${plan.age_max}`,
    `Locations: ${plan.locations.join(", ")}`,
    `Strategy: ${plan.targeting_strategy.replace(/_/g, " ").toLowerCase()}`,
    `Placements: ${placementsLabel}`,
    `Creative: ${plan.creative_strategy.description}`,
    `Optimization: ${plan.optimization_event.replace(/_/g, " ").toLowerCase()}`,
    `Budget: ${budgetLine}`,
    `Facebook Page: ${names.pageName || "(not resolved)"}`,
  ];
  if (names.instagramUsername) lines.push(`Instagram: @${names.instagramUsername}`);
  lines.push(`Status: Paused (won't spend until you approve)`);
  lines.push(``);
  lines.push(`Why:`);
  lines.push(plan.reasoning_summary);
  if (plan.assumptions?.length) {
    lines.push(``);
    lines.push(`Assumptions made:`);
    for (const a of plan.assumptions) lines.push(`- ${a}`);
  }
  if (plan.approval_required && plan.open_questions?.length) {
    lines.push(``);
    lines.push(`Before I can build this, I need you to confirm:`);
    for (const q of plan.open_questions) lines.push(`- ${q}`);
  }
  return lines.join("\n");
}

// Statuses execute_campaign_plan may act on — everything else (executed,
// failed, rejected, superseded) is terminal or requires a fresh plan.
export const EXECUTABLE_STATUSES = new Set(["proposed", "approved"]);

// Full create-plan flow: structural validation -> asset resolution ->
// contextual validation -> store -> format recommendation. Never touches
// Meta beyond read-only resolution calls — no campaign is created here.
//
// conversationId anchors the state machine (Issue 6): any OTHER plan for
// this same user+conversation still sitting in 'proposed' gets marked
// 'superseded' before the new one is inserted — a fresh create_campaign_
// plan call always means either a genuinely new campaign concept or a
// revision, never two simultaneously-live proposals a stale id could
// later be confused between.
//
// revisesPlanId (Scenario E — "change the audience, make it more
// conservative"): when set, the prior plan's daily_budget carries forward
// automatically if this new plan doesn't specify one — "preserve the
// user-approved budget unless the change requires otherwise." Research
// is NOT re-run here; the caller (the agent, per its own instructions)
// only calls research_business_context again if the revision genuinely
// needs new facts, not on every revision.
export async function createPlan({ userId, conversationId, accessToken, plan, contextSummary, revisesPlanId }) {
  const structural = validatePlanStructure(plan); // structural-only pass — context-dependent checks run after resolution, below
  if (!structural.valid) {
    return { ok: false, errors: structural.errors };
  }

  let effectivePlan = plan;
  if (revisesPlanId) {
    const prior = getStoredPlan(userId, revisesPlanId);
    if (prior && (plan.daily_budget === undefined || plan.daily_budget === null) && prior.planData.plan.daily_budget != null) {
      effectivePlan = { ...plan, daily_budget: prior.planData.plan.daily_budget };
    }
  }

  const { resolved, resolutionErrors } = await resolvePlanAssets(effectivePlan, { userId, accessToken });
  const contextual = validatePlanAgainstContext(effectivePlan, {
    resolvedAdAccountId: resolved.adAccountId,
    resolvedPageId: resolved.pageId,
    resolvedPixelId: resolved.pixelId,
    resolvedInstagramId: resolved.instagramId,
    resolvedCatalogId: resolved.catalogId,
  });

  const errors = [...resolutionErrors, ...contextual.errors];
  if (errors.length) {
    return { ok: false, errors };
  }

  // Resolve human-readable names for the recommendation text — the
  // customer sees "BeautyBeesBackup", never "act_237956315579168".
  const [adAccounts, pages] = await Promise.all([meta.listAdAccounts(accessToken), meta.listPages(accessToken)]);
  const names = {
    adAccountName: adAccounts.find((a) => a.id === resolved.adAccountId)?.name || null,
    pageName: pages.find((p) => p.id === resolved.pageId)?.name || null,
    instagramUsername: null, // Phase 1 doesn't fetch the IG username separately — accountId is enough to prove the resolution
  };

  const recommendationText = formatRecommendation(effectivePlan, names);

  const now = new Date().toISOString();
  if (conversationId) {
    db.prepare("UPDATE meta_campaign_plans SET status = 'superseded', updatedAt = ? WHERE userId = ? AND conversationId = ? AND status = 'proposed'")
      .run(now, userId, conversationId);
  }

  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO meta_campaign_plans (id, userId, conversationId, status, planJson, contextJson, recommendationText, revisesPlanId, createdAt, updatedAt)
     VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, conversationId || null, JSON.stringify({ plan: effectivePlan, resolved, names }), JSON.stringify(contextSummary || {}), recommendationText, revisesPlanId || null, now, now);

  return { ok: true, planId: id, recommendationText, resolved, plan: effectivePlan };
}

// Loads a stored plan — re-verifies ownership (never another user's plan).
export function getStoredPlan(userId, planId) {
  const row = db.prepare("SELECT * FROM meta_campaign_plans WHERE id = ? AND userId = ?").get(planId, userId);
  if (!row) return null;
  return { ...row, planData: JSON.parse(row.planJson) };
}

// The plan execute_campaign_plan should act on when the caller doesn't
// name one explicitly — the most recent still-executable (proposed or
// approved) plan for this exact conversation. Never reaches across
// conversations, and never returns an executed/rejected/superseded plan —
// those require a fresh create_campaign_plan call, not silent reuse.
export function getActivePlanForConversation(userId, conversationId) {
  if (!conversationId) return null;
  const row = db.prepare(
    `SELECT * FROM meta_campaign_plans WHERE userId = ? AND conversationId = ? AND status IN ('proposed','approved')
     ORDER BY createdAt DESC LIMIT 1`
  ).get(userId, conversationId);
  if (!row) return null;
  return { ...row, planData: JSON.parse(row.planJson) };
}

export function setPlanStatus(planId, status, extra = {}) {
  const fields = ["status = ?", "updatedAt = ?"];
  const args = [status, new Date().toISOString()];
  if (extra.executionResult !== undefined) { fields.push("executionResultJson = ?"); args.push(JSON.stringify(extra.executionResult)); }
  args.push(planId);
  db.prepare(`UPDATE meta_campaign_plans SET ${fields.join(", ")} WHERE id = ?`).run(...args);
}

export function markPlanExecuted(planId, executionResult) {
  setPlanStatus(planId, "executed", { executionResult });
}

export function markPlanFailed(planId, errorMessage) {
  setPlanStatus(planId, "failed", { executionResult: { error: errorMessage } });
}

export function markPlanRejected(planId) {
  setPlanStatus(planId, "rejected");
}
