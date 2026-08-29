import db from "../../db.js";
import { cryptoRandom } from "../../middleware.js";
import * as meta from "../../integrations/meta/api.js";
import { getConnection } from "../../integrations/manager.js";
import { resolvePageId } from "../../tools/shared/metaPageId.js";
import { resolveAdAccountId } from "../../tools/shared/metaAdAccountId.js";
import { resolvePixelId } from "../../tools/shared/metaPixelId.js";
import { resolveCatalogId } from "../../tools/shared/metaCatalogId.js";
import { validatePlanStructure, validatePlanAgainstContext, PURCHASE_LIKE_EVENTS, normalizePlanEnumAliases, isValidEnumValue } from "./planSchema.js";
import { getConversationAssets, saveConversationAsset, clearConversationAsset } from "./assetSelection.js";
import { checkBudgetPolicy, checkGoalClassificationPolicy, checkAudiencePolicy, isGenericAudience, buildRepairGuidance, MAX_SUGGESTED_DAILY_BUDGET, MAX_EXECUTABLE_DAILY_BUDGET } from "./policy.js";
import { trace, traceEnabled } from "./diagnostics.js";

// Round 6 (live testing): the user could see a plan get rejected but had no
// way to tell, from the logs, which attempt within the conversation it was
// — the existing "goal policy"/"audience policy"/"budget policy" trace
// lines below are per-createPlan-call, with nothing tying them to "this was
// attempt 1" vs "this was the automatic repair." Counted here rather than
// threaded down from orchestrator/index.js's own per-turn retry counter
// (server/orchestrator/index.js's createPlanAttempts) because that would
// mean widening runTool()/execute()'s parameters just for a diagnostic —
// this is a simpler, self-contained counter of createPlan() ENTRIES per
// conversation (so it also counts an attempt that fails structural
// validation, which never reaches the retry gate's own bookkeeping since
// that gate only sees attempts that got as far as being dispatched).
// Deliberately gated on traceEnabled so this Map never grows at all when
// tracing is off (the default) — a plain in-memory counter, so a
// multi-replica deployment would see independent counts per process; fine
// for a temporary diagnostic, not meant as a source of truth.
const conversationAttemptCounts = new Map();
function nextAttemptNumberForConversation(conversationId) {
  if (!traceEnabled) return null;
  const key = conversationId || "no-conversation";
  const n = (conversationAttemptCounts.get(key) || 0) + 1;
  conversationAttemptCounts.set(key, n);
  return n;
}

const SEMANTIC_REFS = new Set(["default_ad_account", "default_facebook_page", "default_instagram_identity", "default_pixel", "default_catalog"]);

// Shared shape behind every asset resolution below (Issue 1 / Issue 4, live
// testing round 3): try an explicit real id first, then a REMEMBERED
// selection for this conversation, then whatever the underlying resolver
// does with neither (single-available auto-use, or ask). If a remembered
// selection turns out to be stale (the resolver's own "verified but not
// found" code), forget it and retry with a clean slate — same "clear on
// invalid, don't keep re-trying a dead value" rule the Default Ad Account
// feature already established. Every returned id has been through the
// underlying resolver's live-Meta cross-check either way; this layer only
// decides WHICH id to try, never skips verification.
//
// `resolve(id)` must resolve to a plain id string, or null/undefined when
// nothing could be resolved (e.g. a Pixel that's genuinely optional and
// ambiguous) — resolveAdAccountId/resolvePageId already return a bare
// string; resolvePixelId/resolveCatalogId return `{ pixelId/catalogId,
// available }`, so their call sites below extract the id before passing it
// in here (`.then((r) => r.pixelId)`), keeping this helper's contract
// uniform instead of guessing at each resolver's own return shape.
async function resolveWithMemory({ conversationId, userId, field, explicitId, savedId, resolve, staleCodes }) {
  let candidate = explicitId;
  let usingSaved = false;
  if (!candidate && savedId) {
    candidate = savedId;
    usingSaved = true;
  }
  // source is purely for diagnostics (below) — never affects resolution.
  let source = candidate ? (usingSaved ? "conversation-remembered" : "explicit-in-plan") : "none-supplied (single-available auto-use, or resolver asks)";
  let id;
  try {
    id = await resolve(candidate);
  } catch (err) {
    if (usingSaved && staleCodes.includes(err.code)) {
      clearConversationAsset(conversationId, field);
      source = "conversation-remembered was STALE, cleared and re-resolved with none supplied";
      id = await resolve(undefined);
    } else {
      trace(`asset resolution FAILED: ${field}`, { conversationId, explicitId: explicitId || null, savedId: savedId || null, candidateSource: source, errorCode: err.code, errorMessage: err.message });
      throw err;
    }
  }
  if (conversationId && id) saveConversationAsset(conversationId, userId, field, id);
  trace(`asset resolution: ${field}`, { conversationId, explicitId: explicitId || null, savedId: savedId || null, candidateSource: source, resolvedId: id || null });
  return id;
}

// Round 11 (live testing), requirements 2/5/6: on a revision, an asset
// field the model didn't declare via `changingAssets` is never even
// offered to the resolver — it's reused DIRECTLY from the prior plan's
// already-resolved id, no network call, no re-derivation. This is
// deliberately stronger than "re-resolve the same ref and hope it lands on
// the same answer": it's the literal prior resolved value, so it can never
// silently drift even if the connected-asset list changes underneath.
// pixel/catalog reuse additionally requires the ad account itself was ALSO
// reused (never re-resolved) — both are scoped to a specific ad account,
// so reusing one without the other could pair a stale Pixel with a
// different account (requirement 6: "preserve that same ad-account/Pixel
// PAIR", never independently). instagram reuse likewise requires the Page
// was reused, since it's derived from the Page. A prior resolved value
// that's missing/falsy is never reused (the lightweight "validate
// preserved assets still exist" the requirements ask for, without an extra
// network round-trip) — resolution falls through to normal handling below.

// Turns a plan's SEMANTIC asset references ("default_ad_account", or a
// real id the model already confirmed earlier this conversation) into
// real, verified Meta ids — Step 5: the LLM must never invent
// pageId/adAccountId/pixelId/catalogId/instagramAccountId, so every one of
// these goes through the same deterministic resolvers the rest of this
// app's Meta tools use (server/tools/shared/*), never trusted from the
// plan directly.
//
// CONFIRMED LIVE BUG (round 12): a real, valid connected id in
// plan.ad_account.ref/facebook_page.ref/etc. was treated as an
// authoritative "the user explicitly picked this" signal purely because it
// happened to be a REAL id rather than a semantic ref like
// "default_ad_account" — nothing distinguished a genuine user-driven
// choice from the model simply emitting a real id on its own (confusion,
// stale memory of a different context, an outright guess). That let a
// model-generated id silently outrank the user's saved Default Ad
// Account/Facebook Page, even on a brand-new plan — round 11 already fixed
// this exact class of bug for REVISIONS via changingAssets; this
// generalizes the same rule to a new plan too: a real id in an asset ref is
// only ever treated as explicit when that field is ALSO declared in
// changingAssets. Conversation-remembered selections (the `saved.*` values
// resolveWithMemory falls back to below) are unaffected — those already
// trace back to a genuine earlier explicit choice (the user answered a
// disambiguation question) and don't need to be redeclared on every
// subsequent call.
function explicitAssetRef(refObj, field, changingAssets) {
  const ref = refObj?.ref;
  if (!ref || SEMANTIC_REFS.has(ref)) return undefined;
  return changingAssets.has(field) ? ref : undefined;
}

// priorResolved/changingAssets (round 11): only present on a revision.
// changingAssets is the set of asset fields the caller has explicitly
// declared the user asked to change this turn — everything NOT in that set
// reuses the prior plan's resolved id directly instead of resolving at
// all. See canReusePrior() above for the ad-account/Pixel/catalog and
// Page/Instagram pairing rules.
export async function resolvePlanAssets(plan, { userId, accessToken, conversationId, priorResolved = null, changingAssets = new Set() }) {
  const resolved = { adAccountId: null, pageId: null, instagramId: null, pixelId: null, catalogId: null };
  const resolutionErrors = [];
  const saved = getConversationAssets(conversationId);

  let adAccountReused = false;
  if (priorResolved?.adAccountId && !changingAssets.has("ad_account")) {
    resolved.adAccountId = priorResolved.adAccountId;
    adAccountReused = true;
  } else {
    try {
      const explicitId = explicitAssetRef(plan.ad_account, "ad_account", changingAssets);
      resolved.adAccountId = await resolveWithMemory({
        conversationId, userId, field: "adAccount", explicitId, savedId: saved.selectedAdAccountId,
        resolve: (id) => resolveAdAccountId({ userId, accessToken, providedAdAccountId: id }),
        staleCodes: ["META_AD_ACCOUNT_NOT_FOUND"],
      });
    } catch (err) {
      resolutionErrors.push({ field: "ad_account", message: err.message, code: err.code });
    }
  }

  let pageReused = false;
  if (priorResolved?.pageId && !changingAssets.has("facebook_page")) {
    resolved.pageId = priorResolved.pageId;
    pageReused = true;
  } else {
    try {
      const explicitId = explicitAssetRef(plan.facebook_page, "facebook_page", changingAssets);
      resolved.pageId = await resolveWithMemory({
        conversationId, userId, field: "facebookPage", explicitId, savedId: saved.selectedFacebookPageId,
        resolve: (id) => resolvePageId({ accessToken, providedPageId: id, userId }),
        staleCodes: ["META_PAGE_NOT_FOUND"],
      });
    } catch (err) {
      resolutionErrors.push({ field: "facebook_page", message: err.message, code: err.code });
    }
  }

  if (plan.instagram_identity && resolved.pageId) {
    if (priorResolved?.instagramId && pageReused && !changingAssets.has("instagram_identity")) {
      resolved.instagramId = priorResolved.instagramId;
    } else {
      resolved.instagramId = await meta.getInstagramAccountId(accessToken, resolved.pageId).catch(() => null);
      if (conversationId && resolved.instagramId) saveConversationAsset(conversationId, userId, "instagram", resolved.instagramId);
    }
  }

  // Attempted whenever the plan references a pixel OR the optimization
  // event needs one to be measured — not only the former. A model that
  // picks PURCHASE optimization but forgets to also set plan.pixel
  // shouldn't skip this check just because it forgot a related field;
  // validatePlanAgainstContext() enforces the actual "Pixel required for
  // this optimization_event" rule regardless of which path resolved it.
  //
  // resolvePixelId already auto-uses the single available Pixel when no id
  // is supplied (server/tools/shared/metaPixelId.js) — Issue 1's "use it
  // automatically" requirement was already true here structurally; what was
  // missing was that a REMEMBERED explicit choice (when more than one
  // Pixel exists) didn't carry forward, which resolveWithMemory now fixes
  // the same way it does for the ad account and Page.
  if ((plan.pixel || PURCHASE_LIKE_EVENTS.has(plan.optimization_event)) && resolved.adAccountId) {
    if (priorResolved?.pixelId && adAccountReused && !changingAssets.has("pixel")) {
      resolved.pixelId = priorResolved.pixelId;
    } else {
      try {
        const explicitId = explicitAssetRef(plan.pixel, "pixel", changingAssets);
        resolved.pixelId = await resolveWithMemory({
          conversationId, userId, field: "pixel", explicitId, savedId: saved.selectedPixelId,
          resolve: (id) => resolvePixelId({ accessToken, adAccountId: resolved.adAccountId, providedPixelId: id, userId }).then((r) => r.pixelId),
          staleCodes: ["META_PIXEL_NOT_FOUND"],
        });
      } catch (err) {
        resolutionErrors.push({ field: "pixel", message: err.message, code: err.code });
      }
    }
  }

  if (plan.catalog && resolved.adAccountId) {
    if (priorResolved?.catalogId && adAccountReused && !changingAssets.has("catalog")) {
      resolved.catalogId = priorResolved.catalogId;
    } else {
      try {
        const explicitId = explicitAssetRef(plan.catalog, "catalog", changingAssets);
        resolved.catalogId = await resolveWithMemory({
          conversationId, userId, field: "catalog", explicitId, savedId: saved.selectedCatalogId,
          resolve: (id) => resolveCatalogId({ accessToken, adAccountId: resolved.adAccountId, providedCatalogId: id }).then((r) => r.catalogId),
          staleCodes: ["META_CATALOG_NOT_FOUND"],
        });
      } catch (err) {
        resolutionErrors.push({ field: "catalog", message: err.message, code: err.code });
      }
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
  // Issue 6 (live testing round 4): a bare number with no explanation reads
  // as an arbitrary guess even when it isn't one — every budget line now
  // says in plain language where it came from, using the SAME budget_basis
  // value checkBudgetPolicy() already enforces server-side, not a separate
  // unchecked claim.
  const BUDGET_BASIS_EXPLANATION = {
    USER_PROVIDED: "as you specified",
    SAVED_POLICY: "based on your saved budget policy",
    HISTORICAL_PERFORMANCE: "based on your account's historical spend",
    HEURISTIC_STARTING_TEST: "as a conservative starting test budget",
  };
  const budgetLine = plan.daily_budget != null
    ? `${plan.daily_budget}/day (${BUDGET_BASIS_EXPLANATION[plan.budget_basis] || "basis not specified"})`
    : "Not yet set — needs your input";
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
  // Round 7 (live testing): approval_required is true for essentially every
  // plan (nothing spends without the user's go-ahead) — that's NOT the same
  // thing as having a genuine unresolved blocker. Branch purely on whether
  // real open_questions exist: if they do, show ONLY those genuine
  // blockers; if the plan is fully resolved, show ONLY a plain approval
  // CTA — never both, and never invent a question just to have something to
  // show here.
  if (plan.open_questions?.length) {
    lines.push(``);
    lines.push(`Before I can build this, I need you to confirm:`);
    for (const q of plan.open_questions) lines.push(`- ${q}`);
  } else {
    lines.push(``);
    lines.push(`Approve this plan to proceed.`);
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
// conservative"): when set, EVERY field the new call doesn't specify is
// carried forward from the prior plan automatically — "preserve what
// wasn't asked to change." Research is NOT re-run here; the caller (the
// agent, per its own instructions) only calls research_business_context
// again if the revision genuinely needs new facts, not on every revision.
//
// CONFIRMED LIVE BUG (round 8): a revision request ("review my data and
// improve the plan" — only audience/budget/reasoning actually changing)
// failed with "Missing required parameter(s): bid_strategy, cta" even
// though those fields were unchanged from the prior, already-valid plan.
// Root cause: this carry-forward previously only applied to daily_budget
// (this comment used to say so) — everything else genuinely required a
// complete resubmission, AND registry.js's tool-level `required` array
// (tools/meta/metaExpert.js) hard-failed a partial submission before this
// function ever ran, before there was any chance to merge. Fixed in two
// places: registry.js's pre-check no longer requires anything for this
// tool (see the `required: []` note in metaExpert.js — the exact same
// "move enforcement past the merge" lesson already applied to
// audience_basis in round 4, now generalized to every field), and the
// merge below (mergePlanForRevision) now applies to the WHOLE plan object,
// not just daily_budget, before normalizePlanDefaults/validatePlanStructure
// ever run — so structural validation always sees a COMPLETE plan (prior
// fields + this call's changes layered on top), never a partial one.
// The plan-level asset reference fields — semantic refs or real ids the
// model puts directly on the plan object. Kept as one list because both
// the merge below and resolvePlanAssets() (which owns the RESOLVED id
// side of the same fields) need to agree on exactly what counts as an
// "asset field."
const ASSET_PLAN_FIELDS = ["ad_account", "facebook_page", "pixel", "catalog", "instagram_identity"];

// CONFIRMED LIVE BUG (round 11): a revision meant to change only audience/
// budget instead switched the ad account (act_237956315579168 ->
// act_769398062628867) and the Facebook Page (Beautybeespk ->
// "careonabudget.pk", sent as a raw NAME instead of a real numeric id) —
// neither asked for by the user. Root cause: round 8/9's plain "any key
// present in `plan` overrides prior" merge treats ANY value the model
// happens to include for an asset field as an intentional change, even
// when the model only restated it as a side effect of fixing an unrelated
// structural error (e.g. being told "ad_account missing" and then
// inventing a value instead of leaving it out so the merge could carry the
// real one forward). Requirement 3: "previous resolved asset > new
// model-generated asset suggestion" — asset fields need a higher bar than
// "the model happened to include this key," so they're merged separately
// and deliberately: any key in ASSET_PLAN_FIELDS that plan sets is
// DISCARDED unless the caller explicitly declared that field is changing
// this turn (changingAssets — see tools/meta/metaExpert.js's dedicated
// parameter for how that gets declared). Every other field keeps the
// original "any key present overrides" behavior from round 9.
function mergePlanForRevision(prior, plan, changingAssets) {
  const merged = { ...prior.planData.plan, ...plan };
  for (const field of ASSET_PLAN_FIELDS) {
    if (!changingAssets.has(field)) merged[field] = prior.planData.plan[field];
  }
  return merged;
}

// Confirmed live (round 4): the model omitted audience_basis on its first
// attempt, which registry.js's validateParameters() (a structural
// required-field check that runs BEFORE execute()/createPlan() ever sees
// the plan) hard-failed with "Missing required parameter(s): audience_basis"
// — the model then had to retry blind. Unlike goal_classification's
// sub-fields (literal_goal, recommended_meta_objective, etc.), which
// genuinely require reasoning about THIS user's actual request and can't
// be safely guessed backend-side, audience_basis has a real, mechanical,
// safe default: STORE_DATA when a commerce platform is actually connected
// (real product/category data genuinely exists to have informed the
// audience), HEURISTIC otherwise. Filling this in before structural
// validation runs means a model that forgets the field never sees a failed
// attempt at all — tools/meta/metaExpert.js also drops audience_basis from
// the tool's own exposed `required` array so registry.js's pre-check
// doesn't hard-fail on it either; this is the actual backstop.
function normalizePlanDefaults(userId, plan) {
  if (plan.audience_basis) return plan;
  const hasStoreData = !!(getConnection(userId, "woocommerce") || getConnection(userId, "shopify"));
  return { ...plan, audience_basis: hasStoreData ? "STORE_DATA" : "HEURISTIC" };
}

// Round 10, requirement 2 (live testing): a cta is a mechanical, safely-
// inferable choice for the common objectives — a model shouldn't have to
// either invent a guess or burn a repair attempt asking about it when a
// clear default exists. Only applies when cta is genuinely missing after
// the revision merge (a revision normally already carries the prior cta
// forward untouched — this only fires for a brand-new plan, or the rare
// case where even the prior plan never had one). Objectives with no safe
// single default (none currently) fall through unchanged — validation then
// asks for it normally, which is the correct behavior "only ask when it
// genuinely cannot be inferred."
const CTA_DEFAULT_BY_OBJECTIVE = {
  OUTCOME_SALES: "SHOP_NOW",
  OUTCOME_LEADS: "SIGN_UP",
  OUTCOME_TRAFFIC: "LEARN_MORE",
  OUTCOME_ENGAGEMENT: "LEARN_MORE",
  OUTCOME_AWARENESS: "LEARN_MORE",
  OUTCOME_APP_PROMOTION: "DOWNLOAD",
};
function deriveCtaIfMissing(plan) {
  if (plan.cta) return plan;
  const derived = CTA_DEFAULT_BY_OBJECTIVE[plan.objective];
  return derived ? { ...plan, cta: derived } : plan;
}

// Round 14 (live production trace), requirement 5: a HEURISTIC_STARTING_TEST
// daily_budget above MAX_SUGGESTED_DAILY_BUDGET is a MECHANICAL, fully
// deterministic correction — checkBudgetPolicy() (policy.js) would reject it
// for exactly this reason every time, with only one possible fix (clamp to
// the same cap). That's not worth spending one of the model's limited repair
// attempts on, same reasoning as normalizePlanEnumAliases/deriveCtaIfMissing
// above. Applied here, before structural/policy validation ever sees the
// plan. budget_basis is deliberately left as HEURISTIC_STARTING_TEST (not
// relabeled) — formatRecommendation()'s "as a conservative starting test
// budget" explanation still applies correctly to the capped number.
function capHeuristicBudget(plan) {
  if (plan.budget_basis !== "HEURISTIC_STARTING_TEST") return plan;
  if (typeof plan.daily_budget !== "number" || plan.daily_budget <= MAX_SUGGESTED_DAILY_BUDGET) return plan;
  return { ...plan, daily_budget: MAX_SUGGESTED_DAILY_BUDGET };
}

// Round 10, requirement 3 (live testing): "the user asked to improve
// audience/budget reasoning, not bidding strategy" — a revision's incoming
// payload restating a field it wasn't actually trying to change (the model
// re-sent bid_strategy verbatim, just spelled wrong) shouldn't sabotage an
// otherwise-correct revision once alias normalization has already had its
// shot. Deliberately narrow: only the mechanical/structural enum fields
// below (never objective, optimization_event, or anything that reflects an
// actual strategy decision the model might be genuinely trying to change)
// — for those, an invalid value should still surface as a real, correctable
// error rather than being silently papered over with the old value.
const PROTECTED_ENUM_FIELDS_ON_REVISION = new Set(["bid_strategy", "placements"]);
function protectValidPriorEnumFieldsOnRevision(prior, plan) {
  let result = plan;
  for (const field of PROTECTED_ENUM_FIELDS_ON_REVISION) {
    const value = result[field];
    if (value === undefined || value === null || isValidEnumValue(field, value)) continue;
    const priorValue = prior.planData.plan[field];
    if (priorValue !== undefined && isValidEnumValue(field, priorValue)) {
      result = { ...result, [field]: priorValue };
    }
  }
  return result;
}

// Round 12 (live testing): a real, non-negotiable literal check — does the
// user's own message text actually contain the claimed number, in any
// reasonable formatting (with/without thousands separators or a currency
// symbol beside it)? Deliberately NOT semantic/NLP: the whole point is a
// mechanical fact-check ("is this digit sequence anywhere in what they
// actually typed"), not an interpretation of intent.
function userMessageContainsAmount(userMessage, amount) {
  if (!userMessage || typeof amount !== "number" || !Number.isFinite(amount)) return false;
  const normalized = userMessage.replace(/[,\s]/g, "");
  return normalized.includes(String(Math.trunc(amount)));
}

// CONFIRMED LIVE BUG (round 12): a production trace showed
// budget_basis: "USER_PROVIDED" for a PKR 10,000 daily budget the user
// never actually stated anywhere in the conversation. USER_PROVIDED is a
// TRUST-BYPASSING claim — policy.js's checkBudgetPolicy() lets it through
// at any size, uncapped, specifically because it's supposed to mean "the
// user said this exact number," unlike HEURISTIC_STARTING_TEST/
// HISTORICAL_PERFORMANCE (both capped at MAX_SUGGESTED_DAILY_BUDGET). The
// model's own claim that a number came from the user can't be trusted any
// more than any other self-reported field this codebase has already had
// to independently verify (pixel existence, commerce connection, asset
// resolution...) — same principle, applied to budget provenance.
//
// Only fires when THIS call is the one actually asserting USER_PROVIDED —
// checked against the RAW, pre-merge `rawPlan` (the exact object the model
// submitted this turn), not the merged/normalized one: a revision that
// silently carries a prior, ALREADY-verified USER_PROVIDED budget forward
// unchanged (the model didn't even mention budget this turn) must not be
// re-flagged just because this turn's message doesn't happen to repeat a
// number it already established validly in an earlier turn.
function verifyUserProvidedBudget(rawPlan, planInput, userMessage) {
  if (rawPlan.budget_basis !== "USER_PROVIDED") return planInput;
  if (userMessageContainsAmount(userMessage, planInput.daily_budget)) return planInput;
  return { ...planInput, budget_basis: "HEURISTIC_STARTING_TEST" };
}

export async function createPlan({ userId, conversationId, accessToken, plan, contextSummary, revisesPlanId, changingAssets: changingAssetsInput, userMessage }) {
  const attemptNumber = nextAttemptNumberForConversation(conversationId);
  // Round 11: an explicit, backend-enforced declaration of which asset
  // fields the user actually asked to change this turn — never inferred
  // from "the model happened to include this field." See
  // ASSET_PLAN_FIELDS/mergePlanForRevision above for how this is used.
  const changingAssets = new Set(Array.isArray(changingAssetsInput) ? changingAssetsInput.filter((f) => ASSET_PLAN_FIELDS.includes(f)) : []);

  let planInput = plan;
  let prior = null;
  if (revisesPlanId) {
    prior = getStoredPlan(userId, revisesPlanId);
    if (!prior) {
      const errors = [{
        field: "revisesPlanId",
        message: `revisesPlanId "${revisesPlanId}" does not match any plan you own — it may be from a different conversation or user, or simply doesn't exist. Omit revisesPlanId to create a fresh plan, or use the real id of a plan created earlier in THIS conversation.`,
      }];
      const repairGuidance = buildRepairGuidance(errors, {});
      trace("createPlan rejection", { conversationId, attemptNumber, stage: "revision_not_found", revisesPlanId, accepted: false, repairGuidance });
      return { ok: false, code: "META_PLAN_REPAIR_REQUIRED", errors, repairGuidance };
    }
    if (!EXECUTABLE_STATUSES.has(prior.status)) {
      const errors = [{
        field: "revisesPlanId",
        message: `The plan "${revisesPlanId}" is no longer active (status: ${prior.status}) and can't be revised. Omit revisesPlanId to create a fresh plan, or revise the CURRENT active plan for this conversation instead.`,
      }];
      const repairGuidance = buildRepairGuidance(errors, {});
      trace("createPlan rejection", { conversationId, attemptNumber, stage: "revision_not_active", revisesPlanId, priorStatus: prior.status, accepted: false, repairGuidance });
      return { ok: false, code: "META_PLAN_REPAIR_REQUIRED", errors, repairGuidance };
    }
    planInput = mergePlanForRevision(prior, plan, changingAssets);
  }

  // Round 12 (live testing): verify a fresh USER_PROVIDED budget claim
  // against the user's actual message BEFORE anything downstream (policy
  // checks, the recommendation text) ever trusts it — see
  // verifyUserProvidedBudget()'s own comment for why `plan` (raw,
  // pre-merge) rather than `planInput` is what decides whether this call
  // is asserting it fresh.
  const preBudgetVerification = planInput;
  planInput = verifyUserProvidedBudget(plan, planInput, userMessage);
  if (traceEnabled && preBudgetVerification.budget_basis !== planInput.budget_basis) {
    trace("createPlan budget provenance downgrade", {
      conversationId, attemptNumber,
      claimedBasis: "USER_PROVIDED", claimedAmount: planInput.daily_budget,
      downgradedTo: planInput.budget_basis,
      userMessagePresent: Boolean(userMessage),
    });
  }

  // Round 10 (live testing), requirement 4's exact order: merge (above) ->
  // normalize canonical values/defaults (below) -> fingerprint (upstream,
  // in orchestrator/index.js, which applies the SAME normalizePlanEnumAliases
  // to the raw call before hashing) -> structural validation -> policy
  // validation. Alias normalization first (fixes the confirmed
  // LOWEST_COST_WITHOUT_BID_CAP case outright), THEN protect a revision's
  // unrelated valid prior fields from a value normalization couldn't
  // resolve, THEN derive a missing cta, THEN clamp an over-cap heuristic
  // budget (round 14) — each step only touches what the previous one left
  // unresolved.
  const { plan: aliasNormalized, appliedAliases } = normalizePlanEnumAliases(planInput);
  const priorProtected = revisesPlanId && prior ? protectValidPriorEnumFieldsOnRevision(prior, aliasNormalized) : aliasNormalized;
  const ctaResolved = deriveCtaIfMissing(priorProtected);
  planInput = capHeuristicBudget(ctaResolved);
  if (traceEnabled && appliedAliases.length) {
    trace("createPlan enum normalization", { conversationId, attemptNumber, appliedAliases });
  }
  if (traceEnabled && planInput.daily_budget !== ctaResolved.daily_budget) {
    trace("createPlan heuristic budget cap", {
      conversationId, attemptNumber,
      original: ctaResolved.daily_budget, capped: planInput.daily_budget, cap: MAX_SUGGESTED_DAILY_BUDGET,
    });
  }

  const normalizedPlan = normalizePlanDefaults(userId, planInput);
  const structural = validatePlanStructure(normalizedPlan); // structural-only pass — context-dependent checks run after resolution, below
  if (!structural.valid) {
    // Issue 2 (live testing round 5): every rejection returns a structured
    // repair payload (field/problem/expectedCorrection), not just a bare
    // errors array — server/orchestrator/index.js's retry-limit gate is
    // what actually bounds how many times the model can act on this, but
    // whichever attempt it is, the guidance should be equally actionable.
    const repairGuidance = buildRepairGuidance(structural.errors, {});
    // Round 6 (live testing): this is the ONE rejection path that used to
    // have zero trace output at all — everything below (goal/audience/
    // budget policy, resolution) never runs when structural validation
    // itself fails, so a plan that's rejected here (a malformed field, not
    // a policy judgment call) was previously invisible to
    // META_EXPERT_TRACE. Logged with the same "createPlan rejection" label
    // as the later rejection path below so a single grep always shows every
    // rejection, whichever stage it happened at.
    trace("createPlan rejection", {
      conversationId, attemptNumber, stage: "structural",
      goalPolicy: null, audiencePolicy: null, budgetPolicy: null,
      resolutionErrors: null, contextualErrors: null, policyErrors: null,
      structuralErrors: structural.errors,
      repairGuidance,
      accepted: false,
    });
    return { ok: false, code: "META_PLAN_REPAIR_REQUIRED", errors: structural.errors, repairGuidance };
  }

  // The revision merge above already folded every carried-forward field
  // (daily_budget included) into normalizedPlan — effectivePlan is just an
  // alias kept because the rest of this function already reads that name.
  const effectivePlan = normalizedPlan;

  const { resolved, resolutionErrors } = await resolvePlanAssets(effectivePlan, {
    userId, accessToken, conversationId,
    priorResolved: prior?.planData?.resolved || null,
    changingAssets,
  });

  // Real, independently-checkable facts (not the model's own claims) that
  // the deterministic policy layer (policy.js) needs — Issue 8: "the LLM
  // can propose strategy, but the backend should reject unsafe or
  // contradictory plans." A commerce platform connection is a DB read, not
  // a network call.
  //
  // CONFIRMED LIVE BUG (round 4): this used to read `!!resolved.pixelId`
  // directly — but resolved.pixelId is ONLY populated a few lines above
  // when the PLAN ITSELF references a pixel or uses a PURCHASE_LIKE_EVENTS
  // optimization_event (line ~107). A Traffic plan with optimization_event
  // LINK_CLICKS never triggers that branch, so resolved.pixelId stayed
  // null EVEN WHEN A REAL PIXEL EXISTS on the account — meaning the whole
  // goal-classification policy below silently never fired for exactly the
  // "traffic requested for an e-commerce store with real tracking" case it
  // exists to catch. Fixed by checking whether a Pixel exists on the
  // resolved ad account independently of whether THIS plan happens to
  // reference one — an extra meta.listPixels call only when the plan's own
  // resolution didn't already answer it.
  //
  // CONFIRMED LIVE BUG (round 14): a production trace showed
  // pixelExists=true, hasPurchaseTracking=true (from this exact block) at
  // the SAME TIME as resolved.pixelId=null — not a contradiction, but two
  // genuinely different facts that nothing downstream distinguished:
  // anyPixelExists only means "at least one Pixel is attached to this ad
  // account"; it says nothing about whether ONE SPECIFIC Pixel could be
  // deterministically chosen (2+ Pixels, no saved default, no explicit
  // choice — resolvePixelId returns null ON PURPOSE rather than guessing,
  // see tools/shared/metaPixelId.js). The model's only visible signal was
  // "Pixel required but missing" (planSchema.js's structural rejection),
  // which it wrongly resolved by abandoning Sales/Purchase for Traffic —
  // exactly the objective-switching repair requirement 4 forbids. Split
  // into explicit named signals so each caller uses the one it actually
  // needs, and to make a pixelAmbiguous plan (2+ available, none resolved)
  // an open_questions ask rather than a hard rejection, below.
  let availablePixelsForAdAccount = [];
  if (resolved.adAccountId) {
    try {
      ({ available: availablePixelsForAdAccount } = await resolvePixelId({ accessToken, adAccountId: resolved.adAccountId, userId }));
    } catch {
      // Best-effort signal only — a failure here must never block plan
      // creation; it just means this specific safety net can't confirm a
      // Pixel exists, not that the plan itself is invalid.
    }
  }
  const anyPixelExists = !!resolved.pixelId || availablePixelsForAdAccount.length > 0;
  const usablePixelForSelectedAdAccount = !!resolved.pixelId;
  const hasStoreData = !!(getConnection(userId, "woocommerce") || getConnection(userId, "shopify"));
  const purchaseTrackingUsable = hasStoreData && usablePixelForSelectedAdAccount;

  // Requirement 3/4 (round 14, live production trace): a PURCHASE-optimized
  // plan whose Pixel is genuinely AMBIGUOUS (2+ usable Pixels on this ad
  // account, none saved as default, none explicit) gets a real, safe path
  // forward — ask once which Pixel to use — instead of being treated
  // identically to "no Pixel exists at all" (a genuine tracking blocker).
  // Deterministic and backend-driven (never left to the model to invent):
  // "1 available" already auto-resolves inside resolvePixelId itself
  // (unchanged); "0 available" still hard-fails in validatePlanAgainstContext
  // below. This branch injects the open_questions entry and sets
  // approval_required BEFORE validatePlanAgainstContext runs, and tells it
  // (via pixelAmbiguous) to treat this as already-handled rather than a
  // rejection — objective/optimization_event are left completely untouched.
  let pixelAmbiguous = false;
  if (PURCHASE_LIKE_EVENTS.has(effectivePlan.optimization_event) && !resolved.pixelId && availablePixelsForAdAccount.length > 1) {
    pixelAmbiguous = true;
    const choices = availablePixelsForAdAccount.map((p) => `${p.name} (${p.id})`).join(", ");
    const question = `This ad account has ${availablePixelsForAdAccount.length} Meta Pixels connected (${choices}) and none is set as the default — which one should track purchases for this campaign?`;
    effectivePlan.open_questions = [...new Set([...(effectivePlan.open_questions || []), question])];
    effectivePlan.approval_required = true;
  }

  const contextual = validatePlanAgainstContext(effectivePlan, {
    resolvedAdAccountId: resolved.adAccountId,
    resolvedPageId: resolved.pageId,
    resolvedPixelId: resolved.pixelId,
    resolvedInstagramId: resolved.instagramId,
    resolvedCatalogId: resolved.catalogId,
    pixelAmbiguous,
  });

  // hasStrongerAudienceEvidence (Issue 3): only fetched when it could
  // actually change the outcome — a generic, HEURISTIC-basis audience with
  // no store data already known — so a normal plan never pays for this
  // extra call. hasStoreData alone already counts as stronger evidence
  // without needing this.
  let hasCampaignHistory = false;
  if (isGenericAudience(effectivePlan) && effectivePlan.audience_basis === "HEURISTIC" && !hasStoreData && resolved.adAccountId) {
    try {
      const campaigns = await meta.listCampaigns(accessToken, resolved.adAccountId);
      hasCampaignHistory = campaigns.length > 0;
    } catch {
      // Best-effort signal only — never blocks plan creation on its own.
    }
  }

  // clearEcommerceWithPurchaseTracking deliberately stays keyed on
  // anyPixelExists (not usablePixelForSelectedAdAccount) — requirement 4:
  // pixel-resolution AMBIGUITY must never be a reason to stop forcing
  // Sales/Purchase for a real e-commerce business. Whether a SPECIFIC Pixel
  // could be resolved this attempt is an execution-readiness question
  // (purchaseTrackingUsable, resolvedPixelId), not a goal-classification one.
  const businessSignals = {
    anyPixelExists,
    usablePixelForSelectedAdAccount,
    purchaseTrackingUsable,
    clearEcommerceWithPurchaseTracking: hasStoreData && anyPixelExists,
    hasStrongerAudienceEvidence: hasStoreData || hasCampaignHistory,
  };
  const goalPolicyErrors = checkGoalClassificationPolicy(effectivePlan, businessSignals);
  const budgetPolicyErrors = checkBudgetPolicy(effectivePlan);
  const audiencePolicyErrors = checkAudiencePolicy(effectivePlan, businessSignals);

  // TEMPORARY (live testing round 5) — see diagnostics.js. Every input the
  // three policy functions actually see, and their actual return value —
  // not a re-derivation, the literal values passed in and the literal
  // arrays returned, so this can't itself be wrong in a way that hides a
  // real discrepancy. Built as named objects (not inlined into trace()
  // calls) so the SAME input/result shape can also be embedded in the
  // single consolidated "createPlan rejection" trace below (round 6) —
  // one grep for that label shows the complete picture regardless of
  // which policy actually rejected the plan.
  const goalPolicyTrace = {
    input: {
      literalGoal: effectivePlan.goal_classification?.literal_goal ?? null,
      proposedObjective: effectivePlan.objective,
      proposedOptimizationEvent: effectivePlan.optimization_event,
      requiresGoalConfirmation: effectivePlan.goal_classification?.requires_goal_confirmation ?? null,
      recommendedMetaObjective: effectivePlan.goal_classification?.recommended_meta_objective ?? null,
      commerceConnected: hasStoreData,
      anyPixelExists,
      usablePixelForSelectedAdAccount,
      pixelAmbiguous,
      isEcommerce: businessSignals.clearEcommerceWithPurchaseTracking,
      hasPurchaseTracking: businessSignals.purchaseTrackingUsable,
    },
    result: goalPolicyErrors.length ? "REJECTED" : "accepted",
    errors: goalPolicyErrors,
  };
  const audiencePolicyTrace = {
    input: {
      gender: effectivePlan.gender,
      age_min: effectivePlan.age_min,
      age_max: effectivePlan.age_max,
      audience_basis: effectivePlan.audience_basis,
      audience_reasoning: effectivePlan.audience_reasoning ?? null,
      isGenericAudience: isGenericAudience(effectivePlan),
      hasStrongerAudienceEvidence: businessSignals.hasStrongerAudienceEvidence,
      hasStoreData,
      hasCampaignHistory,
    },
    result: audiencePolicyErrors.length ? "REJECTED" : "accepted",
    errors: audiencePolicyErrors,
  };
  const budgetPolicyTrace = {
    input: {
      proposedDailyBudget: effectivePlan.daily_budget,
      budget_basis: effectivePlan.budget_basis,
      MAX_SUGGESTED_DAILY_BUDGET,
      MAX_EXECUTABLE_DAILY_BUDGET,
    },
    result: budgetPolicyErrors.length ? "REJECTED" : "accepted",
    errors: budgetPolicyErrors,
  };
  trace("goal policy", { ...goalPolicyTrace.input, policyResult: goalPolicyTrace.result, policyErrors: goalPolicyTrace.errors });
  trace("audience policy", { ...audiencePolicyTrace.input, policyResult: audiencePolicyTrace.result, policyErrors: audiencePolicyTrace.errors });
  trace("budget policy", { ...budgetPolicyTrace.input, policyResult: budgetPolicyTrace.result, policyErrors: budgetPolicyTrace.errors });

  const policyErrors = [...goalPolicyErrors, ...budgetPolicyErrors, ...audiencePolicyErrors];

  const errors = [...resolutionErrors, ...contextual.errors, ...policyErrors];
  // Round 14 (live production trace) requirement 6's exact acceptance-test
  // field list — one trace line carrying every field the production trace
  // needs to confirm Pixel resolution end-to-end without cross-referencing
  // the separate goal-policy/asset-resolution lines above.
  trace("createPlan final decision", {
    conversationId,
    accepted: errors.length === 0,
    resolutionErrors,
    contextualErrors: contextual.errors,
    policyErrors,
    resolvedAdAccountId: resolved.adAccountId,
    resolvedPageId: resolved.pageId,
    anyPixelExists,
    usablePixelForSelectedAdAccount,
    resolvedPixelId: resolved.pixelId,
    pixelAmbiguous,
    objective: effectivePlan.objective,
    optimization_event: effectivePlan.optimization_event,
    daily_budget: effectivePlan.daily_budget,
    budget_basis: effectivePlan.budget_basis,
  });
  if (errors.length) {
    const facts = {
      businessSignals,
      budgetCaps: { suggested: MAX_SUGGESTED_DAILY_BUDGET, executable: MAX_EXECUTABLE_DAILY_BUDGET },
      resolvedAdAccountId: resolved.adAccountId,
      resolvedPageId: resolved.pageId,
      resolvedPixelId: resolved.pixelId,
    };
    const repairGuidance = buildRepairGuidance(errors, facts);
    // Round 6 (live testing): one consolidated line with everything needed
    // to diagnose a rejection without cross-referencing the separate goal/
    // audience/budget/final-decision lines above — same "createPlan
    // rejection" label as the structural-failure path above, so a single
    // grep for that label always shows every rejection this conversation
    // hit, whichever stage it happened at.
    trace("createPlan rejection", {
      conversationId, attemptNumber, stage: "policy_and_resolution",
      goalPolicy: goalPolicyTrace,
      audiencePolicy: audiencePolicyTrace,
      budgetPolicy: budgetPolicyTrace,
      resolutionErrors,
      contextualErrors: contextual.errors,
      policyErrors,
      repairGuidance,
      accepted: false,
    });
    return { ok: false, code: "META_PLAN_REPAIR_REQUIRED", errors, repairGuidance };
  }

  // Resolve human-readable names for the recommendation text — the
  // customer sees "BeautyBeesBackup", never "act_237956315579168". Round
  // 11: when an asset was REUSED from the prior plan rather than
  // re-resolved, its name is reused from the prior plan's own stored
  // `names` too, instead of an unconditional fresh meta.listAdAccounts()/
  // listPages() call — part of "no meta.list_pages call is required" for a
  // revision that isn't touching Pages/ad accounts at all.
  const adAccountNameReusable = revisesPlanId && prior && !changingAssets.has("ad_account") && resolved.adAccountId === prior.planData.resolved?.adAccountId;
  const pageNameReusable = revisesPlanId && prior && !changingAssets.has("facebook_page") && resolved.pageId === prior.planData.resolved?.pageId;
  const [adAccountName, pageName] = await Promise.all([
    adAccountNameReusable && prior.planData.names
      ? prior.planData.names.adAccountName
      : meta.listAdAccounts(accessToken).then((accounts) => accounts.find((a) => a.id === resolved.adAccountId)?.name || null),
    pageNameReusable && prior.planData.names
      ? prior.planData.names.pageName
      : meta.listPages(accessToken).then((pages) => pages.find((p) => p.id === resolved.pageId)?.name || null),
  ]);
  const names = {
    adAccountName, pageName,
    instagramUsername: null, // Phase 1 doesn't fetch the IG username separately — accountId is enough to prove the resolution
  };
  trace("final selected Page/ad account", { resolvedPageId: resolved.pageId, resolvedPageName: names.pageName, resolvedAdAccountId: resolved.adAccountId, resolvedAdAccountName: names.adAccountName });

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
