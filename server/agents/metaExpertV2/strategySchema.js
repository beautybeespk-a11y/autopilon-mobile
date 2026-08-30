// Meta Ads Expert V2 — strategy schema + structural/contextual validation.
// Deliberately self-contained: does NOT import anything from
// server/agents/metaExpert/ (the original planner) — V2 is a from-scratch
// rebuild beside it, not an extension of its internals. Same "no JSON
// Schema library dependency, hand-roll the rules against the .json
// contract" approach as the original for consistency of style, but this
// file owns its OWN rules independently so a future change to V1's schema
// can never silently affect V2 or vice versa.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INTERNAL_STRATEGY_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "internal_strategy_schema.json"), "utf8"));

const ENUM_FIELDS = {
  recommended_objective: INTERNAL_STRATEGY_SCHEMA.properties.recommended_objective.enum,
  optimization_event: INTERNAL_STRATEGY_SCHEMA.properties.optimization_event.enum,
  conversion_location: INTERNAL_STRATEGY_SCHEMA.properties.conversion_location.enum,
  audience_strategy: INTERNAL_STRATEGY_SCHEMA.properties.audience_strategy.enum,
  gender: INTERNAL_STRATEGY_SCHEMA.properties.gender.enum,
  targeting_approach: INTERNAL_STRATEGY_SCHEMA.properties.targeting_approach.enum,
  placements: INTERNAL_STRATEGY_SCHEMA.properties.placements.enum,
  budget_basis: INTERNAL_STRATEGY_SCHEMA.properties.budget_basis.enum,
  bid_strategy: INTERNAL_STRATEGY_SCHEMA.properties.bid_strategy.enum,
  cta: INTERNAL_STRATEGY_SCHEMA.properties.cta.enum,
  campaign_status: INTERNAL_STRATEGY_SCHEMA.properties.campaign_status.enum,
  mode: INTERNAL_STRATEGY_SCHEMA.properties.mode.enum,
  action_type: INTERNAL_STRATEGY_SCHEMA.properties.action_type.enum,
};

export const BUDGET_BASIS_VALUES = INTERNAL_STRATEGY_SCHEMA.properties.budget_basis.enum;
export const PURCHASE_LIKE_EVENTS = new Set(["PURCHASE", "ADD_TO_CART"]);

export function isValidEnumValue(field, value) {
  const allowed = ENUM_FIELDS[field];
  return Array.isArray(allowed) && allowed.includes(value);
}

// Small, deliberately conservative set of real-world naming-drift aliases —
// same reasoning as V1's ENUM_ALIASES (server/agents/metaExpert/
// planSchema.js): each entry reflects genuine Meta terminology or an
// obviously-equivalent paraphrase, applied deterministically BEFORE
// structural validation runs so a harmless spelling variant never counts
// as a real validation failure (Step 7 — V2 gets exactly one generation
// attempt, so a repair-worthy failure must be a REAL one).
const ENUM_ALIASES = {
  bid_strategy: {
    LOWEST_COST_WITHOUT_BID_CAP: "LOWEST_COST_WITHOUT_CAP",
    LOWEST_COST_AUTOMATIC: "LOWEST_COST_WITHOUT_CAP",
    AUTOMATIC_BIDDING: "LOWEST_COST_WITHOUT_CAP",
    LOWEST_COST_WITH_CAP: "LOWEST_COST_WITH_BID_CAP",
    MANUAL_BID_CAP: "LOWEST_COST_WITH_BID_CAP",
    COST_CAP_BID: "COST_CAP",
  },
  recommended_objective: {
    CONVERSIONS: "OUTCOME_SALES",
    PRODUCT_CATALOG_SALES: "OUTCOME_SALES",
    SALES: "OUTCOME_SALES",
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
  targeting_approach: {
    BROAD: "BROAD_WITH_TEST",
    LOOKALIKE: "LOOKALIKE_AUDIENCE",
    RETARGET: "RETARGETING",
    ADVANTAGE_PLUS: "ADVANTAGE_PLUS_AUDIENCE",
  },
};

export function normalizeStrategyEnumAliases(strategy) {
  const appliedAliases = [];
  const normalized = { ...strategy };
  for (const [field, aliasMap] of Object.entries(ENUM_ALIASES)) {
    const value = normalized[field];
    if (typeof value === "string" && Object.prototype.hasOwnProperty.call(aliasMap, value)) {
      normalized[field] = aliasMap[value];
      appliedAliases.push({ field, from: value, to: aliasMap[value] });
    }
  }
  return { strategy: normalized, appliedAliases };
}

// Objectives with a single, safe default CTA — a purely mechanical
// normalization (Step 7: never spend a generation attempt on this).
const CTA_DEFAULT_BY_OBJECTIVE = {
  OUTCOME_SALES: "SHOP_NOW",
  OUTCOME_LEADS: "SIGN_UP",
  OUTCOME_TRAFFIC: "LEARN_MORE",
  OUTCOME_ENGAGEMENT: "LEARN_MORE",
  OUTCOME_AWARENESS: "LEARN_MORE",
  OUTCOME_APP_PROMOTION: "DOWNLOAD",
};
export function deriveCtaIfMissing(strategy) {
  if (strategy.cta) return strategy;
  const derived = CTA_DEFAULT_BY_OBJECTIVE[strategy.recommended_objective];
  return derived ? { ...strategy, cta: derived } : strategy;
}

// Structural-only pass — no network/DB access, no context needed. Mirrors
// internal_strategy_schema.json's `required` + enum rules directly.
export function validateStrategyStructure(strategy) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!strategy || typeof strategy !== "object") return { valid: false, errors: [{ field: null, message: "Strategy must be an object." }] };

  const mode = strategy.mode || "campaign";
  // explicit_action strategies are deliberately lightweight — they skip
  // most of the campaign-shaped required fields (audience/placements/
  // creative_strategy/targeting_approach don't apply to "boost this exact
  // post") but still need the fields that genuinely govern real spend.
  const requiredForMode =
    mode === "explicit_action"
      ? ["business_goal", "action_type", "budget_basis", "campaign_status", "reasoning_summary", "evidence_used", "assumptions", "approval_required", "facebook_page", "ad_account"]
      : INTERNAL_STRATEGY_SCHEMA.required;

  for (const field of requiredForMode) {
    if (strategy[field] === undefined || strategy[field] === null || strategy[field] === "") {
      fail(field, `Missing required field "${field}".`);
    }
  }

  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    if (strategy[field] !== undefined && strategy[field] !== null && !allowed.includes(strategy[field])) {
      fail(field, `"${field}" must be one of: ${allowed.join(", ")}. Got "${strategy[field]}".`);
    }
  }

  if (mode === "explicit_action") {
    if (!strategy.content_selector || typeof strategy.content_selector !== "object") {
      fail("content_selector", "content_selector is required for an explicit_action strategy — refer to content by its ordinal position in the business snapshot's recentContent list, or attachedMediaRef for a chat-attached file. Never a raw invented id.");
    }
  } else {
    if (Number.isInteger(strategy.age_min) === false && strategy.age_min !== undefined) fail("age_min", "age_min must be an integer.");
    if (Number.isInteger(strategy.age_max) === false && strategy.age_max !== undefined) fail("age_max", "age_max must be an integer.");
    if (typeof strategy.age_min === "number" && (strategy.age_min < 13 || strategy.age_min > 65)) fail("age_min", "age_min must be between 13 and 65.");
    if (typeof strategy.age_max === "number" && (strategy.age_max < 13 || strategy.age_max > 65)) fail("age_max", "age_max must be between 13 and 65.");
    if (typeof strategy.age_min === "number" && typeof strategy.age_max === "number" && strategy.age_min > strategy.age_max) {
      fail("age_min", `age_min (${strategy.age_min}) must not be greater than age_max (${strategy.age_max}).`);
    }
    if (!Array.isArray(strategy.locations) || strategy.locations.length === 0 || strategy.locations.some((l) => typeof l !== "string" || !l.trim())) {
      fail("locations", "locations must be a non-empty array of non-empty place names.");
    }
    if (!Array.isArray(strategy.countries) || strategy.countries.length === 0 || strategy.countries.some((c) => typeof c !== "string" || !/^[A-Z]{2}$/.test(c))) {
      fail("countries", "countries must be a non-empty array of 2-letter ISO 3166-1 country codes (e.g. \"PK\") — what real Meta targeting is actually built from.");
    }
    if (strategy.placements === "MANUAL" && (!Array.isArray(strategy.manual_placements) || strategy.manual_placements.length === 0)) {
      fail("manual_placements", "manual_placements is required (and must be non-empty) when placements is MANUAL.");
    }
    if (!strategy.creative_strategy || typeof strategy.creative_strategy !== "object") {
      fail("creative_strategy", "creative_strategy is required and must be an object with source + description.");
    } else {
      const validSources = INTERNAL_STRATEGY_SCHEMA.properties.creative_strategy.properties.source.enum;
      if (!validSources.includes(strategy.creative_strategy.source)) fail("creative_strategy.source", `creative_strategy.source must be one of: ${validSources.join(", ")}.`);
      if (!strategy.creative_strategy.description || typeof strategy.creative_strategy.description !== "string") fail("creative_strategy.description", "creative_strategy.description is required.");
    }
  }

  if (!strategy.facebook_page || typeof strategy.facebook_page.ref !== "string" || !strategy.facebook_page.ref) {
    fail("facebook_page", "facebook_page.ref is required (a semantic reference like \"default_facebook_page\", or a real, already-confirmed Page id).");
  }
  if (!strategy.ad_account || typeof strategy.ad_account.ref !== "string" || !strategy.ad_account.ref) {
    fail("ad_account", "ad_account.ref is required (a semantic reference like \"default_ad_account\", or a real, already-confirmed ad account id).");
  }

  if (strategy.budget_daily !== undefined && strategy.budget_daily !== null) {
    if (typeof strategy.budget_daily !== "number" || strategy.budget_daily < 0) fail("budget_daily", "budget_daily must be a non-negative number, or null.");
  }
  if (!strategy.budget_basis || !BUDGET_BASIS_VALUES.includes(strategy.budget_basis)) {
    fail("budget_basis", `budget_basis is required — one of: ${BUDGET_BASIS_VALUES.join(", ")}. Never propose a real number without saying where it came from.`);
  }

  if (strategy.campaign_status !== undefined && strategy.campaign_status !== "PAUSED") {
    fail("campaign_status", 'campaign_status must be "PAUSED" — a newly proposed strategy never starts active.');
  }

  if (!Array.isArray(strategy.assumptions)) fail("assumptions", "assumptions must be an array (can be empty).");
  if (!Array.isArray(strategy.evidence_used)) fail("evidence_used", "evidence_used must be an array (can be empty, but should list the concrete facts actually used).");
  if (typeof strategy.approval_required !== "boolean") fail("approval_required", "approval_required must be a boolean.");

  if (strategy.unresolved_questions !== undefined && (!Array.isArray(strategy.unresolved_questions) || strategy.unresolved_questions.some((q) => typeof q !== "string" || !q.trim()))) {
    fail("unresolved_questions", "unresolved_questions, when present, must be an array of real, specific, non-empty strings — each one a genuine unresolved BUSINESS decision, never a technical/asset question or a placeholder.");
  }

  return { valid: errors.length === 0, errors };
}

// Context-dependent checks — needs the resolved real ids
// (assetResolution.js), so this runs after resolution, separate from
// validateStrategyStructure().
export function validateStrategyAgainstContext(strategy, { resolvedAdAccountId, resolvedPageId, resolvedPixelId, resolvedInstagramId, resolvedCatalogId, pixelAmbiguous = false } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (!resolvedAdAccountId) fail("ad_account", "No ad account could be resolved for this strategy — a real, connected ad account is required.");
  if (!resolvedPageId) fail("facebook_page", "No Facebook Page could be resolved for this strategy — a real, connected Page is required.");

  if (strategy.instagram_identity && !resolvedInstagramId) {
    fail("instagram_identity", "The strategy references an Instagram identity, but none could be resolved (Instagram may not be connected).");
  }

  if (strategy.mode !== "explicit_action" && PURCHASE_LIKE_EVENTS.has(strategy.optimization_event) && !resolvedPixelId && !pixelAmbiguous) {
    fail("pixel", `optimization_event "${strategy.optimization_event}" requires a Meta Pixel to measure it, and this ad account has no Pixel set up at all — a real tracking-setup gap, not a reason to change the objective. Keep the recommended objective as proposed, explain the tracking blocker to the user, and offer Traffic only as an explicit, separate alternative if genuinely wanted.`);
  }

  if (strategy.catalog?.ref && !resolvedCatalogId) {
    fail("catalog", "The strategy references a product catalog, but none could be resolved — a catalog/dynamic-ad campaign needs a real, connected catalog.");
  }

  if ((strategy.budget_daily === null || strategy.budget_daily === undefined) && strategy.approval_required !== true) {
    fail("budget_daily", "No budget_daily was proposed and approval_required is not true — a strategy must either propose a real budget or honestly flag that budget input is needed.");
  }

  return { valid: errors.length === 0, errors };
}
