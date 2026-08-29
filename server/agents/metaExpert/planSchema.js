import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INTERNAL_PLAN_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "internal_plan_schema.json"), "utf8"));

const ENUM_FIELDS = {
  objective: INTERNAL_PLAN_SCHEMA.properties.objective.enum,
  conversion_location: INTERNAL_PLAN_SCHEMA.properties.conversion_location.enum,
  optimization_event: INTERNAL_PLAN_SCHEMA.properties.optimization_event.enum,
  targeting_strategy: INTERNAL_PLAN_SCHEMA.properties.targeting_strategy.enum,
  gender: INTERNAL_PLAN_SCHEMA.properties.gender.enum,
  placements: INTERNAL_PLAN_SCHEMA.properties.placements.enum,
  budget_strategy: INTERNAL_PLAN_SCHEMA.properties.budget_strategy.enum,
  bid_strategy: INTERNAL_PLAN_SCHEMA.properties.bid_strategy.enum,
  cta: INTERNAL_PLAN_SCHEMA.properties.cta.enum,
  campaign_status: INTERNAL_PLAN_SCHEMA.properties.campaign_status.enum,
  confidence: INTERNAL_PLAN_SCHEMA.properties.confidence.enum,
  audience_basis: INTERNAL_PLAN_SCHEMA.properties.audience_basis.enum,
};

const GOAL_CLASSIFICATION_OBJECTIVE_ENUM = INTERNAL_PLAN_SCHEMA.properties.goal_classification.properties.recommended_meta_objective.enum;
export const BUDGET_BASIS_VALUES = INTERNAL_PLAN_SCHEMA.properties.budget_basis.enum;

export function isValidEnumValue(field, value) {
  const allowed = ENUM_FIELDS[field];
  return Array.isArray(allowed) && allowed.includes(value);
}

// Round 10 (live testing, CONFIRMED): a real production revision was
// rejected twice — burning the one automatic repair attempt — over
// bid_strategy: "LOWEST_COST_WITHOUT_BID_CAP", which the model kept
// producing on both attempts. The schema's canonical value is
// LOWEST_COST_WITHOUT_CAP; "without bid cap" is a completely reasonable,
// harmless paraphrase of "without a cap on the bid" — the kind of naming
// drift a model reasoning in plain English will produce regardless of how
// the prompt is worded, so this is handled deterministically here rather
// than through another prompt instruction. The rest of this map is NOT
// speculative guessing — each entry reflects real, documented Meta Ads
// platform terminology this schema's canonical values supersede: the
// pre-ODAX (Outcome-Driven Ad Experiences) legacy objective names Meta
// used before campaigns were reorganized around OUTCOME_* objectives, and
// "Automatic Placements" being renamed to "Advantage+ placements." Kept
// deliberately small — only entries with a real, confident basis — rather
// than an exhaustive guess at every possible phrasing.
const ENUM_ALIASES = {
  bid_strategy: {
    LOWEST_COST_WITHOUT_BID_CAP: "LOWEST_COST_WITHOUT_CAP",
    LOWEST_COST_AUTOMATIC: "LOWEST_COST_WITHOUT_CAP",
    AUTOMATIC_BIDDING: "LOWEST_COST_WITHOUT_CAP",
    LOWEST_COST_WITH_CAP: "LOWEST_COST_WITH_BID_CAP",
    MANUAL_BID_CAP: "LOWEST_COST_WITH_BID_CAP",
    COST_CAP_BID: "COST_CAP",
  },
  objective: {
    CONVERSIONS: "OUTCOME_SALES",
    PRODUCT_CATALOG_SALES: "OUTCOME_SALES",
    TRAFFIC: "OUTCOME_TRAFFIC",
    LEAD_GENERATION: "OUTCOME_LEADS",
    LEADS: "OUTCOME_LEADS",
    POST_ENGAGEMENT: "OUTCOME_ENGAGEMENT",
    ENGAGEMENT: "OUTCOME_ENGAGEMENT",
    BRAND_AWARENESS: "OUTCOME_AWARENESS",
    AWARENESS: "OUTCOME_AWARENESS",
    APP_INSTALLS: "OUTCOME_APP_PROMOTION",
  },
  placements: {
    AUTOMATIC: "ADVANTAGE_PLUS",
    AUTOMATIC_PLACEMENTS: "ADVANTAGE_PLUS",
    ADVANTAGE_PLACEMENTS: "ADVANTAGE_PLUS",
  },
  optimization_event: {
    LINK_CLICK: "LINK_CLICKS",
    LANDING_PAGE_VIEW: "LANDING_PAGE_VIEWS",
    COMPLETE_REGISTRATIONS: "COMPLETE_REGISTRATION",
  },
  cta: {
    SHOP: "SHOP_NOW",
    BUY_NOW: "SHOP_NOW",
    SIGNUP: "SIGN_UP",
    CONTACT: "CONTACT_US",
    GET_A_QUOTE: "GET_QUOTE",
  },
};

// Pure and stateless — no DB/network access, so it's safe to call from
// BOTH planner.js (on the merged plan, before structural validation) and
// the orchestrator's plan-attempt fingerprint (on the raw, possibly
// partial submission) — the exact "apply normalization before
// fingerprinting" ordering requested, so two submissions that only differ
// by a harmless alias spelling still fingerprint identically instead of
// looking like a genuinely different repair.
export function normalizePlanEnumAliases(plan) {
  const appliedAliases = [];
  const normalized = { ...plan };
  for (const [field, aliasMap] of Object.entries(ENUM_ALIASES)) {
    const value = normalized[field];
    if (typeof value === "string" && Object.prototype.hasOwnProperty.call(aliasMap, value)) {
      normalized[field] = aliasMap[value];
      appliedAliases.push({ field, from: value, to: aliasMap[value] });
    }
  }
  return { plan: normalized, appliedAliases };
}

// No JSON Schema library is a dependency of this project today (confirmed:
// no ajv in package.json) — rather than add one for a single schema, this
// directly implements internal_plan_schema.json's own rules. The two files
// are meant to be read together: the .json is the human-readable contract,
// this enforces it. Purely structural — no network/DB access, no context
// needed, so it can run standalone in tests.
export function validatePlanStructure(plan) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!plan || typeof plan !== "object") return { valid: false, errors: [{ field: null, message: "Plan must be an object." }] };

  for (const field of INTERNAL_PLAN_SCHEMA.required) {
    if (plan[field] === undefined || plan[field] === null || plan[field] === "") {
      fail(field, `Missing required field "${field}".`);
    }
  }

  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    if (plan[field] !== undefined && plan[field] !== null && !allowed.includes(plan[field])) {
      fail(field, `"${field}" must be one of: ${allowed.join(", ")}. Got "${plan[field]}".`);
    }
  }

  if (typeof plan.goal !== "undefined" && typeof plan.goal !== "string") fail("goal", "goal must be a string.");
  if (typeof plan.reasoning_summary !== "undefined" && typeof plan.reasoning_summary !== "string") fail("reasoning_summary", "reasoning_summary must be a string.");

  if (Number.isInteger(plan.age_min) === false && plan.age_min !== undefined) fail("age_min", "age_min must be an integer.");
  if (Number.isInteger(plan.age_max) === false && plan.age_max !== undefined) fail("age_max", "age_max must be an integer.");
  if (typeof plan.age_min === "number" && (plan.age_min < 13 || plan.age_min > 65)) fail("age_min", "age_min must be between 13 and 65.");
  if (typeof plan.age_max === "number" && (plan.age_max < 13 || plan.age_max > 65)) fail("age_max", "age_max must be between 13 and 65.");
  if (typeof plan.age_min === "number" && typeof plan.age_max === "number" && plan.age_min > plan.age_max) {
    fail("age_min", `age_min (${plan.age_min}) must not be greater than age_max (${plan.age_max}).`);
  }

  if (!Array.isArray(plan.locations) || plan.locations.length === 0 || plan.locations.some((l) => typeof l !== "string" || !l.trim())) {
    fail("locations", "locations must be a non-empty array of non-empty place names.");
  }

  if (!Array.isArray(plan.countries) || plan.countries.length === 0 || plan.countries.some((c) => typeof c !== "string" || !/^[A-Z]{2}$/.test(c))) {
    fail("countries", "countries must be a non-empty array of 2-letter ISO 3166-1 country codes (e.g. \"PK\", \"US\") — this is what real Meta targeting is built from.");
  }

  if (plan.placements === "MANUAL" && (!Array.isArray(plan.manual_placements) || plan.manual_placements.length === 0)) {
    fail("manual_placements", "manual_placements is required (and must be non-empty) when placements is MANUAL.");
  }

  if (!plan.creative_strategy || typeof plan.creative_strategy !== "object") {
    fail("creative_strategy", "creative_strategy is required and must be an object with source + description.");
  } else {
    const validSources = INTERNAL_PLAN_SCHEMA.properties.creative_strategy.properties.source.enum;
    if (!validSources.includes(plan.creative_strategy.source)) {
      fail("creative_strategy.source", `creative_strategy.source must be one of: ${validSources.join(", ")}.`);
    }
    if (!plan.creative_strategy.description || typeof plan.creative_strategy.description !== "string") {
      fail("creative_strategy.description", "creative_strategy.description is required.");
    }
  }

  if (!plan.facebook_page || typeof plan.facebook_page.ref !== "string" || !plan.facebook_page.ref) {
    fail("facebook_page", "facebook_page.ref is required (a semantic reference like \"default_facebook_page\", or a real, already-confirmed Page id).");
  }
  if (!plan.ad_account || typeof plan.ad_account.ref !== "string" || !plan.ad_account.ref) {
    fail("ad_account", "ad_account.ref is required (a semantic reference like \"default_ad_account\", or a real, already-confirmed ad account id).");
  }

  if (plan.daily_budget !== undefined && plan.daily_budget !== null) {
    if (typeof plan.daily_budget !== "number" || plan.daily_budget < 0) fail("daily_budget", "daily_budget must be a non-negative number, or null.");
    if (!plan.budget_basis || !BUDGET_BASIS_VALUES.includes(plan.budget_basis)) {
      fail("budget_basis", `budget_basis is required whenever daily_budget is set — one of: ${BUDGET_BASIS_VALUES.join(", ")}. Never propose a real number without saying where it came from.`);
    }
  }

  if (!plan.goal_classification || typeof plan.goal_classification !== "object") {
    fail("goal_classification", "goal_classification is required: { literal_goal, inferred_business_outcome, recommended_meta_objective, requires_goal_confirmation }.");
  } else {
    const gc = plan.goal_classification;
    if (typeof gc.literal_goal !== "string" || !gc.literal_goal.trim()) fail("goal_classification.literal_goal", "goal_classification.literal_goal is required.");
    if (typeof gc.inferred_business_outcome !== "string" || !gc.inferred_business_outcome.trim()) fail("goal_classification.inferred_business_outcome", "goal_classification.inferred_business_outcome is required.");
    if (!GOAL_CLASSIFICATION_OBJECTIVE_ENUM.includes(gc.recommended_meta_objective)) {
      fail("goal_classification.recommended_meta_objective", `goal_classification.recommended_meta_objective must be one of: ${GOAL_CLASSIFICATION_OBJECTIVE_ENUM.join(", ")}.`);
    }
    if (typeof gc.requires_goal_confirmation !== "boolean") fail("goal_classification.requires_goal_confirmation", "goal_classification.requires_goal_confirmation must be a boolean.");
  }

  if (plan.campaign_status !== undefined && plan.campaign_status !== "PAUSED") {
    fail("campaign_status", 'campaign_status must be "PAUSED" — a newly proposed plan never starts active.');
  }

  if (!Array.isArray(plan.assumptions)) fail("assumptions", "assumptions must be an array (can be empty).");

  if (typeof plan.approval_required !== "boolean") fail("approval_required", "approval_required must be a boolean.");
  // Round 7 (live testing): this used to hard-fail approval_required=true
  // with an empty open_questions array — the CONFIRMED root cause of the
  // production create_campaign_plan retry loop ("I want more sales to my
  // website"). That rule conflated two different things: approval_required
  // means "the user must approve before this spends money," which is true
  // for essentially every plan; open_questions means "there's a genuine
  // unresolved blocker the model can't safely guess past." A fully-resolved
  // Sales plan for a connected e-commerce store legitimately has
  // approval_required=true (nothing executes without approval) AND
  // open_questions=[] (nothing is actually ambiguous) — the model was being
  // forced to invent a fake clarifying question just to pass validation.
  // open_questions is still type-checked below (an array of real,
  // non-empty strings when present) — only the "must be non-empty" rule is
  // gone. A GENUINE unresolved blocker (ambiguous asset choice, pending
  // goal-objective confirmation, etc.) still requires a real open_questions
  // entry, but that's enforced where the actual ambiguity is detected
  // (policy.js's checkGoalClassificationPolicy, asset resolution errors),
  // not as a blanket structural rule here.
  if (plan.open_questions !== undefined && (!Array.isArray(plan.open_questions) || plan.open_questions.some((q) => typeof q !== "string" || !q.trim()))) {
    fail("open_questions", "open_questions, when present, must be an array of real, specific, non-empty strings — each one a genuine unresolved blocker, never a placeholder or invented question. An empty array (or omitting the field) is valid and expected for a fully-resolved plan.");
  }

  return { valid: errors.length === 0, errors };
}

// Loose, deliberately non-exhaustive intent keyword sets — used only to
// catch a CLEAR mismatch between the user's own stated goal and the chosen
// Meta objective (e.g. goal talks about sales/purchases but the plan
// proposes Awareness). This is NOT meant to resolve every nuanced case —
// e.g. a store owner asking for "traffic" as a deliberate top-of-funnel
// test is legitimate, and this validator does not second-guess that call.
// The harder judgment case (a casual word like "traffic" vs. what actually
// serves an e-commerce business) is agent REASONING, not something a
// keyword rule can safely generalize — see the Meta Ads Expert's own
// instructions (server/orchestrator/agentLibrary.js) for that guidance,
// and the Phase 1 completion report for why it's split this way.
const SALES_INTENT_WORDS = /\b(sale|sales|purchase|purchases|buy|buying|revenue|order|orders|checkout|conversion|conversions|e-?commerce)\b/i;
const OBVIOUSLY_MISMATCHED_OBJECTIVES_FOR_SALES_INTENT = new Set(["OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT"]);

// Shared with planner.js's resolvePlanAssets(): which optimization_event
// values need a Pixel to even measure. Exported so pixel resolution can be
// attempted whenever the OPTIMIZATION EVENT requires it, not only when the
// plan happens to also set plan.pixel — a model that picks PURCHASE but
// forgets to also reference a pixel shouldn't get a free pass past this
// check just because it forgot one of two related fields.
export const PURCHASE_LIKE_EVENTS = new Set(["PURCHASE", "ADD_TO_CART"]);

// Context-dependent checks (Step 6) — needs the resolved real ids
// (server/tools/shared/*), not just the plan's semantic references, so
// this is separate from validatePlanStructure() and only runs once
// resolution has happened.
export function validatePlanAgainstContext(plan, { resolvedAdAccountId, resolvedPageId, resolvedPixelId, resolvedInstagramId, resolvedCatalogId } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (typeof plan.goal === "string" && SALES_INTENT_WORDS.test(plan.goal) && OBVIOUSLY_MISMATCHED_OBJECTIVES_FOR_SALES_INTENT.has(plan.objective)) {
    fail("objective", `The stated goal ("${plan.goal}") clearly describes sales/purchase intent, but the objective chosen is ${plan.objective} — that's not aligned. Use OUTCOME_SALES (or OUTCOME_TRAFFIC as a deliberate, explained intermediate step) instead.`);
  }

  if (!resolvedAdAccountId) fail("ad_account", "No ad account could be resolved for this plan — a real, connected ad account is required.");
  if (!resolvedPageId) fail("facebook_page", "No Facebook Page could be resolved for this plan — a real, connected Page is required.");

  if (plan.instagram_identity && !resolvedInstagramId) {
    fail("instagram_identity", "The plan references an Instagram identity, but none could be resolved (Instagram may not be connected).");
  }

  if (PURCHASE_LIKE_EVENTS.has(plan.optimization_event) && !resolvedPixelId) {
    fail("pixel", `optimization_event "${plan.optimization_event}" requires a Meta Pixel to measure it, but no Pixel is available on this ad account. Either set one up in Events Manager first, or choose a different optimization_event this account can actually support.`);
  }

  if (plan.catalog?.ref && !resolvedCatalogId) {
    fail("catalog", "The plan references a product catalog, but none could be resolved — a catalog/dynamic-ad campaign needs a real, connected catalog.");
  }

  // Budget: either a real number is proposed, or approval_required is
  // honestly set so the user is asked rather than silently defaulted.
  if ((plan.daily_budget === null || plan.daily_budget === undefined) && plan.approval_required !== true) {
    fail("daily_budget", "No daily_budget was proposed and approval_required is not true — a plan must either propose a real budget or honestly flag that budget input is needed.");
  }

  return { valid: errors.length === 0, errors };
}

// Convenience wrapper running both passes — what callers actually use.
export function validatePlan(plan, context) {
  const structural = validatePlanStructure(plan);
  const contextual = structural.valid ? validatePlanAgainstContext(plan, context) : { valid: true, errors: [] };
  const errors = [...structural.errors, ...contextual.errors];
  return { valid: errors.length === 0, errors };
}
