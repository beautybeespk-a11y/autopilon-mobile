// Deterministic decision policy layer (Issue 8, live testing round 3).
// The model can propose strategy, but these checks run in plain code
// against real facts (connected commerce platform, resolved Pixel,
// caller-supplied numbers) and can reject a plan the model produced,
// regardless of how convincing its prose is. Nothing here calls an LLM.
//
// Kept as one small module rather than scattering each rule across
// planner.js/metaExpert.js so the full policy surface is readable in one
// place — createPlan() (planner.js) is the only caller for plan-creation
// checks; execute_campaign_plan (tools/meta/metaExpert.js) reuses the
// budget cap as defense-in-depth right before spending anything real.
import crypto from "node:crypto";

// Configurable via env — deploy-time policy, not yet a per-org UI setting
// (that's a reasonable v2; documented as a known limitation in the round 3
// report). Values are in the ad account's currency's smallest unit, same
// unit daily_budget is already expressed in.
export const MAX_SUGGESTED_DAILY_BUDGET = Number(process.env.META_EXPERT_MAX_SUGGESTED_DAILY_BUDGET) || 5000;
export const MAX_EXECUTABLE_DAILY_BUDGET = Number(process.env.META_EXPERT_MAX_EXECUTABLE_DAILY_BUDGET) || 10000;

// Live bug: the agent independently proposed PKR 80,000/day with no
// evidence behind it. budget_basis (planSchema.js) makes the model state
// WHERE a number came from; this caps the two bases that are the model's
// own guess (as opposed to a real user instruction or a saved account
// policy) — a recommendation, not a user instruction, needs to stay
// conservative or be backed by real evidence.
const SELF_SOURCED_BASES = new Set(["HISTORICAL_PERFORMANCE", "HEURISTIC_STARTING_TEST"]);

export function checkBudgetPolicy(plan) {
  const errors = [];
  if (plan.daily_budget === null || plan.daily_budget === undefined) return errors;

  if (SELF_SOURCED_BASES.has(plan.budget_basis) && plan.daily_budget > MAX_SUGGESTED_DAILY_BUDGET) {
    errors.push({
      field: "daily_budget",
      message: `A ${plan.budget_basis === "HEURISTIC_STARTING_TEST" ? "heuristic starting-test" : "historically-derived"} daily budget of ${plan.daily_budget} exceeds the safe maximum suggested budget of ${MAX_SUGGESTED_DAILY_BUDGET} without stronger evidence. Recommend a conservative test budget within this limit, or use budget_basis USER_PROVIDED (the user actually said this number) or SAVED_POLICY (a real saved account default) if there's a genuine basis for going higher.`,
    });
  }

  if (plan.daily_budget > MAX_EXECUTABLE_DAILY_BUDGET) {
    errors.push({
      field: "daily_budget",
      message: `A daily budget of ${plan.daily_budget} exceeds the hard maximum executable daily budget of ${MAX_EXECUTABLE_DAILY_BUDGET} — no plan may be created (or executed) above this limit regardless of basis. Propose a lower budget, or this account's approved maximum needs to be raised first (META_EXPERT_MAX_EXECUTABLE_DAILY_BUDGET).`,
    });
  }

  return errors;
}

// businessSignals.clearEcommerceWithPurchaseTracking: true only when BOTH a
// real commerce platform is connected (WooCommerce/Shopify — real products
// exist) AND a Meta Pixel was actually resolved for this plan (real
// purchase-event tracking exists) — two independently-checkable facts, not
// a guess. This is deliberately conservative: a business missing either
// signal is NOT forced through this gate (nothing here second-guesses a
// legitimate Traffic campaign for a non-commerce business, or a store with
// no Pixel set up yet — that's a real limitation on what this rule can
// safely enforce, not laziness; see planSchema.js's SALES_INTENT_WORDS
// comment for the same reasoning applied to the goal/objective mismatch
// check).
export function checkGoalClassificationPolicy(plan, businessSignals = {}) {
  const errors = [];
  const gc = plan.goal_classification;
  if (!gc || typeof gc !== "object") return errors; // structural validation already failed this — nothing more to check

  if (!businessSignals.clearEcommerceWithPurchaseTracking) return errors;

  if (plan.objective === "OUTCOME_TRAFFIC" && gc.requires_goal_confirmation !== true) {
    errors.push({
      field: "goal_classification",
      message: "This is a connected e-commerce business with real purchase tracking (a resolved Pixel) — a Traffic objective must not be built silently. Set goal_classification.requires_goal_confirmation = true, set objective to the recommended one (goal_classification.recommended_meta_objective, usually OUTCOME_SALES), and use open_questions to offer Traffic as the alternative if the user genuinely wants pure visits.",
    });
  }

  if (gc.requires_goal_confirmation === true) {
    if (plan.objective !== gc.recommended_meta_objective) {
      errors.push({
        field: "objective",
        message: `goal_classification.requires_goal_confirmation is true — the plan itself must propose the recommended objective (${gc.recommended_meta_objective}), with open_questions offering the literal one ("${gc.literal_goal}") as an alternative if the user genuinely wants that instead. Don't build ${plan.objective} directly while confirmation is still pending.`,
      });
    }
    if (plan.approval_required !== true || !Array.isArray(plan.open_questions) || plan.open_questions.length === 0) {
      errors.push({
        field: "open_questions",
        message: "goal_classification.requires_goal_confirmation is true — approval_required must be true and open_questions must actually raise the objective tradeoff (literal_goal vs. recommended_meta_objective) so the user can confirm which one they want.",
      });
    }
  }

  return errors;
}

// A "completely generic" audience — nothing narrowed at all — is the exact
// shape live testing (round 4) flagged as suspicious by default: All
// genders, 18-65 is Meta's own widest possible range, not a considered
// choice. Using >= / <= rather than === on the ages so an even WIDER
// (invalid per schema, but defensive) range doesn't slip past this check.
export function isGenericAudience(plan) {
  return plan.gender === "ALL" && plan.age_min <= 18 && plan.age_max >= 65;
}

// businessSignals.hasStrongerAudienceEvidence: real data existed that
// COULD have informed a narrower audience (a connected store's product/
// category data, or this ad account's own campaign history) — independent
// of whether the plan actually used it. Same "check the real fact, not the
// plan's own claim" principle as clearEcommerceWithPurchaseTracking above.
export function checkAudiencePolicy(plan, businessSignals = {}) {
  const errors = [];
  if (!isGenericAudience(plan)) return errors;

  // A generic audience is only ever acceptable with an explicit reason —
  // Issue 3: "require an explicit audience_basis and audience_reasoning."
  // audience_basis is already structurally required on every plan
  // (planSchema.js); audience_reasoning is intentionally NOT a top-level
  // required schema field (that would reintroduce the exact
  // "Missing required parameter" brittleness audience_basis itself just
  // had fixed — see tools/meta/metaExpert.js) — it's required here,
  // conditionally, only for the specific case that needs it.
  if (typeof plan.audience_reasoning !== "string" || !plan.audience_reasoning.trim()) {
    errors.push({
      field: "audience_reasoning",
      message: "A fully generic audience (all genders, 18-65) requires an explicit audience_reasoning explaining why no narrower targeting applies — e.g. a genuinely universal product, or a brand-new account with no data yet.",
    });
  }

  if (plan.audience_basis === "HEURISTIC" && businessSignals.hasStrongerAudienceEvidence) {
    errors.push({
      field: "audience_basis",
      message: "A fully generic audience with basis HEURISTIC isn't justified — real data exists that could inform this (connected store/product data or this ad account's own campaign history). Use audience_basis STORE_DATA, PRODUCT_CATEGORY, ACCOUNT_HISTORY, or META_PERFORMANCE and narrow the audience using that evidence instead.",
    });
  }

  return errors;
}

// Backend gate for meta_expert.execute_campaign_plan (Issue 6) — checked in
// server/orchestrator/index.js BEFORE the tool is even dispatched, so a
// model that decides to call execute_campaign_plan as its first action
// (no plan ever presented, no approval ever given) is blocked in code, not
// left to system-prompt instructions alone. Deliberately a small, explicit
// phrase set rather than a loose "contains yes" check — approving a
// specific real-money action should require unambiguous language.
const EXECUTION_APPROVAL_PATTERN = /\b(approve|approved|proceed|run it|launch it|go ahead|do it|confirm(ed)?|create it|build it|make it live|start it)\b|\byes[,.]?\s+(create|launch|run|build|do)\s+it\b/i;

export function messageIndicatesExecutionApproval(text) {
  return typeof text === "string" && EXECUTION_APPROVAL_PATTERN.test(text);
}

// Live testing round 5: "I want more sales to my website" looped the
// orchestrator on meta_expert.create_campaign_plan six times until
// MAX_STEPS was hit — nothing detected the model resubmitting an
// unchanged (or trivially reworded) plan after a rejection. This is a
// stable fingerprint over the STRATEGIC fields only — not free-text
// fields like reasoning_summary or assumptions, which the model could
// vary trivially between attempts without actually fixing anything, which
// would make a naive whole-object comparison useless. server/orchestrator/
// index.js uses this to detect and immediately block a genuinely identical
// resubmission (META_PLAN_DUPLICATE_RETRY) rather than spending another
// full model round-trip discovering the same rejection again.
const STRATEGIC_SCALAR_FIELDS = [
  "objective", "optimization_event", "targeting_strategy", "age_min", "age_max",
  "gender", "placements", "budget_strategy", "daily_budget", "budget_basis", "cta", "conversion_location",
];
export function fingerprintPlan(plan = {}) {
  const normalized = {};
  for (const field of STRATEGIC_SCALAR_FIELDS) normalized[field] = plan[field] ?? null;
  normalized.locations = [...(plan.locations || [])].sort();
  normalized.countries = [...(plan.countries || [])].sort();
  normalized.ad_account_ref = plan.ad_account?.ref ?? null;
  normalized.facebook_page_ref = plan.facebook_page?.ref ?? null;
  normalized.pixel_ref = plan.pixel?.ref ?? null;
  normalized.catalog_ref = plan.catalog?.ref ?? null;
  normalized.recommended_meta_objective = plan.goal_classification?.recommended_meta_objective ?? null;
  normalized.requires_goal_confirmation = plan.goal_classification?.requires_goal_confirmation ?? null;
  normalized.audience_basis = plan.audience_basis ?? null;
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

// Turns raw validation/policy errors (field + message) into a repair
// payload a model can act on deterministically — Issue 2's explicit ask:
// "field, problem, expected correction, non-secret research facts needed
// to repair it." `facts` is whatever non-secret, already-computed context
// the caller has on hand (businessSignals, the two budget caps, etc.) —
// never re-derived here, just passed through, so this never becomes a
// second source of truth for what those values actually are.
const EXPECTED_CORRECTION_BY_FIELD = {
  ad_account: "Set ad_account.ref to one of the real, connected ad account ids named in the problem above — or set a Default Ad Account in Integrations to stop needing this every time.",
  facebook_page: "Set facebook_page.ref to one of the real, connected Page ids named in the problem above — or set a Default Facebook Page in Integrations to stop needing this every time.",
  pixel: "Either set pixel.ref to a real, connected Pixel id, or change optimization_event to one that doesn't require a Pixel.",
  catalog: "Either set catalog.ref to a real, connected catalog id, or remove the catalog reference if this isn't a catalog/dynamic-ad campaign.",
  daily_budget: "Lower daily_budget to within the stated limit, or only use budget_basis USER_PROVIDED/SAVED_POLICY if that is genuinely true.",
  budget_basis: "Set budget_basis honestly to reflect where this number actually came from.",
  audience_reasoning: "Add a real, specific audience_reasoning explaining why no narrower targeting applies.",
  audience_basis: "Use a real evidence-based audience_basis instead of HEURISTIC when real account/store data exists.",
  goal_classification: "Set goal_classification.requires_goal_confirmation and recommended_meta_objective honestly, and align objective with the recommendation.",
  objective: "Set objective to match goal_classification.recommended_meta_objective while goal confirmation is pending.",
  open_questions: "Set approval_required true and add a real, specific open_questions entry raising the tradeoff.",
};
export function buildRepairGuidance(errors, facts = {}) {
  return errors.map((e) => ({
    field: e.field || null,
    problem: e.message,
    expectedCorrection: EXPECTED_CORRECTION_BY_FIELD[e.field] || "Fix this field per the problem description above.",
    relevantFacts: facts,
  }));
}
