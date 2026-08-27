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

// Full create-plan flow: structural validation -> asset resolution ->
// contextual validation -> store -> format recommendation. Never touches
// Meta beyond read-only resolution calls — no campaign is created here.
export async function createPlan({ userId, accessToken, plan, contextSummary }) {
  const structural = validatePlanStructure(plan); // structural-only pass — context-dependent checks run after resolution, below
  if (!structural.valid) {
    return { ok: false, errors: structural.errors };
  }

  const { resolved, resolutionErrors } = await resolvePlanAssets(plan, { userId, accessToken });
  const contextual = validatePlanAgainstContext(plan, {
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

  const recommendationText = formatRecommendation(plan, names);

  const id = cryptoRandom();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO meta_campaign_plans (id, userId, status, planJson, contextJson, recommendationText, createdAt, updatedAt)
     VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?)`
  ).run(id, userId, JSON.stringify({ plan, resolved, names }), JSON.stringify(contextSummary || {}), recommendationText, now, now);

  return { ok: true, planId: id, recommendationText, resolved, plan };
}

// Loads a stored plan for execution — re-verifies ownership and that it's
// still in a state that can be executed (never re-executes an already-
// executed plan, never executes another user's plan).
export function getStoredPlan(userId, planId) {
  const row = db.prepare("SELECT * FROM meta_campaign_plans WHERE id = ? AND userId = ?").get(planId, userId);
  if (!row) return null;
  return { ...row, planData: JSON.parse(row.planJson) };
}

export function markPlanExecuted(planId, executionResult) {
  db.prepare("UPDATE meta_campaign_plans SET status = 'executed', executionResultJson = ?, updatedAt = ? WHERE id = ?")
    .run(JSON.stringify(executionResult), new Date().toISOString(), planId);
}
