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
import { isGenericAudience } from "./policy.js";

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
  // Live bug (round 22): a strategy with bid_strategy LOWEST_COST_WITH_
  // BID_CAP (or COST_CAP) reached real execution and Meta rejected the Ad
  // Set creation outright: "(#100/1815857) Bid amount required: you must
  // provide a bid cap or target cost in bid_amount field." Nothing in
  // this schema, the executor, or Meta's real API call anywhere has ever
  // had a bid_amount field to populate — these two bid strategies are
  // GUARANTEED to fail at execution 100% of the time in this system, not
  // a legitimate choice being taken away. Every variant/synonym is
  // normalized straight to the one bid strategy that actually works
  // (never requires a companion field) — see internal_strategy_schema.json,
  // whose own enum was narrowed to match.
  bid_strategy: {
    LOWEST_COST_WITHOUT_BID_CAP: "LOWEST_COST_WITHOUT_CAP",
    LOWEST_COST_AUTOMATIC: "LOWEST_COST_WITHOUT_CAP",
    AUTOMATIC_BIDDING: "LOWEST_COST_WITHOUT_CAP",
    LOWEST_COST_WITH_CAP: "LOWEST_COST_WITHOUT_CAP",
    LOWEST_COST_WITH_BID_CAP: "LOWEST_COST_WITHOUT_CAP",
    MANUAL_BID_CAP: "LOWEST_COST_WITHOUT_CAP",
    COST_CAP_BID: "LOWEST_COST_WITHOUT_CAP",
    COST_CAP: "LOWEST_COST_WITHOUT_CAP",
    TARGET_COST: "LOWEST_COST_WITHOUT_CAP",
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
// Live bug: the model occasionally omits approval_required entirely
// (a plain boolean field, not a business decision) — validateStrategyStructure
// then hard-rejects the WHOLE strategy over it, and since V2 caps
// build_strategy at one real attempt per turn (the per-turn single-call
// gate), the customer sees a confusing final message quoting the raw
// internal field name back at them ("the field approval_required is
// required... please confirm you approve...") instead of an actual
// recommendation. Mechanical, not a business decision (Step 7: never
// spend the model's one generation attempt on something this trivial) —
// defaulting a MISSING value to `true` (never overwrites an explicit
// `false`) is always the conservative choice: real execution is
// separately, unconditionally gated by checkV2ExecutionApprovalGate in
// orchestrator/index.js regardless of this field, and the one other place
// this field is read (validateStrategyAgainstContext's budget_daily
// check) only ever gets MORE lenient when it's true, never less safe.
export function deriveApprovalRequiredIfMissing(strategy) {
  if (typeof strategy.approval_required === "boolean") return strategy;
  return { ...strategy, approval_required: true };
}

// Live bug (same class as approval_required above): the model occasionally
// omits facebook_page/ad_account entirely from its build_strategy call.
// Per this tool's own description (metaExpertV2.js) and internal_strategy_
// schema.json's own $comment, these are semantic refs the backend ALREADY
// resolves automatically to the saved default (or the single connected
// one, or an ambiguity question) whenever the model hasn't explicitly
// asked for a specific different one via explicitAssetChanges — an
// entirely absent field is behaviorally indistinguishable from the model
// correctly writing { ref: "default_facebook_page" } / { ref:
// "default_ad_account" }, just a mechanical slip in how it wrote the
// call, not a business decision. Never overwrites a ref the model DID
// provide (including a real, already-confirmed id from an earlier turn)
// — only fills in when the field is completely absent. Resolution itself
// still goes through the exact same assetResolution.js path either way,
// so this changes nothing about WHICH asset ultimately gets used, only
// whether a trivially-omittable field crashes the whole recommendation.
export function deriveDefaultAssetRefsIfMissing(strategy) {
  let result = strategy;
  if (!result.facebook_page || typeof result.facebook_page.ref !== "string" || !result.facebook_page.ref) {
    result = { ...result, facebook_page: { ref: "default_facebook_page" } };
  }
  if (!result.ad_account || typeof result.ad_account.ref !== "string" || !result.ad_account.ref) {
    result = { ...result, ad_account: { ref: "default_ad_account" } };
  }
  return result;
}

// Live bug (round 22): a build_strategy/revise_strategy call was rejected
// outright for "Missing required field \"countries\"" — locations
// (human-readable place names, e.g. "Pakistan") is a separate field the
// model reliably fills in, but countries (the real ISO 3166-1 alpha-2
// codes Meta targeting actually needs) was sometimes left off entirely,
// especially right after a wrong-tool recovery (revise_strategy ->
// build_strategy) where the model appears to lose track of a field it
// had already stated in plain English one line above. Only ever fires
// when EVERY location name maps unambiguously to a real ISO code via
// this lookup — a name that doesn't match (a city, an unusual spelling)
// leaves countries untouched and the honest structural rejection stands,
// same "never guess wrong, only fill in what's already objectively
// known" principle as the other derive*IfMissing functions. Deliberately
// not exhaustive — covers the countries this platform's real customers
// actually target, not all ~195 countries on Earth.
const COMMON_COUNTRY_NAME_TO_ISO = {
  pakistan: "PK", "united states": "US", usa: "US", "united states of america": "US", us: "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB",
  india: "IN", canada: "CA", australia: "AU",
  "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA", qatar: "QA", kuwait: "KW", bahrain: "BH", oman: "OM",
  germany: "DE", france: "FR", italy: "IT", spain: "ES", netherlands: "NL", "the netherlands": "NL",
  bangladesh: "BD", nigeria: "NG", "south africa": "ZA", egypt: "EG", turkey: "TR", kenya: "KE",
  indonesia: "ID", malaysia: "MY", philippines: "PH", singapore: "SG", "sri lanka": "LK", nepal: "NP", vietnam: "VN", thailand: "TH",
  brazil: "BR", mexico: "MX", argentina: "AR", ireland: "IE", "new zealand": "NZ", japan: "JP", "south korea": "KR", china: "CN",
};
// Longest names first so a multi-word match (e.g. "united arab emirates")
// is tried before a shorter one that could otherwise match a substring of
// it first. Two-letter/three-letter abbreviations (us, uk, uae) are
// deliberately excluded from substring matching below — as a whole-word
// match inside a longer free-text location string they're too easy to
// false-positive on unrelated text; they still work fine as an EXACT
// whole-string location value (the fast path below).
const COUNTRY_NAMES_FOR_SUBSTRING_MATCH = Object.keys(COMMON_COUNTRY_NAME_TO_ISO)
  .filter((name) => name.length > 3)
  .sort((a, b) => b.length - a.length);
function findCountryCodeInLocationText(text) {
  const lower = text.trim().toLowerCase();
  if (COMMON_COUNTRY_NAME_TO_ISO[lower]) return COMMON_COUNTRY_NAME_TO_ISO[lower];
  for (const name of COUNTRY_NAMES_FOR_SUBSTRING_MATCH) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) return COMMON_COUNTRY_NAME_TO_ISO[name];
  }
  return undefined;
}
export function deriveCountriesFromLocationsIfMissing(strategy) {
  if (Array.isArray(strategy.countries) && strategy.countries.length) return strategy;
  if (!Array.isArray(strategy.locations) || !strategy.locations.length) return strategy;
  // Live bug (round 25): the exact-whole-string match above missed a
  // location the model wrote with any extra qualifier around the country
  // name — "Karachi, Pakistan", "Pakistan (Nationwide)", "All of Pakistan"
  // — even though the country is right there in the text, especially
  // right after a wrong-tool recovery where the model reconstructs the
  // strategy from scratch and phrases the location less tersely than the
  // first time. Recognizing the country name ANYWHERE in the string (as a
  // real whole word, not a fragment) keeps the same "never guess, only
  // resolve what's objectively already named" guarantee — it still never
  // fires unless one of this table's actual country names is literally
  // present — while covering the common qualified phrasings.
  const mapped = strategy.locations.map((loc) => (typeof loc === "string" ? findCountryCodeInLocationText(loc) : undefined));
  if (mapped.some((code) => !code)) return strategy; // an unrecognized location — never guess, leave the honest rejection in place
  return { ...strategy, countries: [...new Set(mapped)] };
}

// Live bug (round 18): after execute_strategy was correctly blocked for a
// missing budget and the user was asked for one, they answered with a
// plain number ("500/day") — and the model's NEXT build_strategy/
// revise_strategy call STILL omitted budget_daily, over and over across
// many turns, even though the number the user had JUST typed was sitting
// right there in userMessage. Each cycle re-asked for the same number the
// user had already given, an infinite loop from the customer's side.
// Unlike audience_reasoning (a free-text business justification) or a
// truly invented number, this is safe to fill in ONLY when the exact
// amount is extractable from the USER'S OWN CURRENT MESSAGE — the same
// standard verifyUserProvidedBudget (policy.js) already uses to validate
// a USER_PROVIDED claim, just applied the other direction: deriving the
// missing value FROM the message instead of only checking a claimed one
// against it. Deliberately narrow (currency-prefixed, "/day"-suffixed, or
// the ENTIRE message is just a bare number — never a stray digit
// mid-sentence) and capped at 6 digits so it can never mistake a long
// Pixel/ad-account id pasted into the chat for a budget.
const USER_MESSAGE_BUDGET_PATTERN = /(?:\b(?:pkr|rs\.?|usd)\s*|\$\s*)([\d][\d,]{0,5})\b|\b([\d][\d,]{0,5})\s*(?:\/|per\s+)\s*day\b|^\s*([\d][\d,]{0,5})\s*(?:\/day)?\s*$/i;
export function deriveBudgetFromUserMessageIfMissing(strategy, userMessage) {
  if (strategy.budget_daily !== null && strategy.budget_daily !== undefined) return strategy;
  if (typeof userMessage !== "string") return strategy;
  const match = USER_MESSAGE_BUDGET_PATTERN.exec(userMessage);
  if (!match) return strategy;
  const amount = Number((match[1] || match[2] || match[3]).replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return strategy;
  return { ...strategy, budget_daily: amount, budget_basis: "USER_PROVIDED" };
}

// Live bug (round 15): even after strengthening this field's tool
// description, the model still routinely leaves a fully generic audience
// (ALL, 18-65) with NO audience_reasoning when NO real store/account data
// exists to narrow by — build_strategy is a single-attempt tool (Step 7),
// so a missed free-text field here has no retry chance and hard-rejects
// an otherwise-sound strategy. This is ONLY safe to auto-fill in the
// specific case where `businessSignals.hasStrongerAudienceEvidence` is
// false: at that point "no narrower targeting applies" isn't the model's
// judgment call, it's an objective fact the backend already verified from
// the snapshot (same class of fix as deriveApprovalRequiredIfMissing/
// deriveDefaultAssetRefsIfMissing above — the correct value is forced
// regardless of business context). When hasStrongerAudienceEvidence IS
// true, this deliberately does NOT fire — leaving a generic audience
// unexplained while real store/campaign data exists is a genuine
// analysis failure the model must actually address (still hard-rejected,
// same as checkAudienceQualityPolicy's separate audience_strategy check
// for that case).
export function deriveAudienceReasoningIfMissing(strategy, businessSignals = {}) {
  if (strategy.mode === "explicit_action") return strategy;
  if (!isGenericAudience(strategy)) return strategy;
  if (typeof strategy.audience_reasoning === "string" && strategy.audience_reasoning.trim()) return strategy;
  if (businessSignals.hasStrongerAudienceEvidence) return strategy;
  return {
    ...strategy,
    audience_reasoning: "No connected store data or Meta ad account history exists yet to narrow this audience further, so Meta's full available range (all genders, 18-65) is used.",
  };
}

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
