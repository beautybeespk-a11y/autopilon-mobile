// Meta Ads Expert V2 — deterministic decision policy + quality gates
// (Step 5). Nothing here calls an LLM; every check runs in plain code
// against real facts (the trusted business snapshot, resolved assets,
// caller-supplied numbers) and can reject a strategy the model produced,
// regardless of how convincing its prose is.
//
// Self-contained — does not import from server/agents/metaExpert/ (V1).
// Budget caps default to the SAME env vars V1 already uses when a V2-
// specific override isn't set, since they describe the same real-world
// safety limit on the same ad accounts (spending real money either way) —
// but can be tuned independently via META_EXPERT_V2_MAX_*.
import crypto from "node:crypto";

export const MAX_SUGGESTED_DAILY_BUDGET =
  Number(process.env.META_EXPERT_V2_MAX_SUGGESTED_DAILY_BUDGET) ||
  Number(process.env.META_EXPERT_MAX_SUGGESTED_DAILY_BUDGET) || 5000;
export const MAX_EXECUTABLE_DAILY_BUDGET =
  Number(process.env.META_EXPERT_V2_MAX_EXECUTABLE_DAILY_BUDGET) ||
  Number(process.env.META_EXPERT_MAX_EXECUTABLE_DAILY_BUDGET) || 10000;

const SELF_SOURCED_BASES = new Set(["HISTORICAL_PERFORMANCE", "HEURISTIC_STARTING_TEST"]);

export function checkBudgetPolicy(strategy) {
  const errors = [];
  if (strategy.budget_daily === null || strategy.budget_daily === undefined) return errors;

  if (SELF_SOURCED_BASES.has(strategy.budget_basis) && strategy.budget_daily > MAX_SUGGESTED_DAILY_BUDGET) {
    errors.push({
      field: "budget_daily",
      message: `A ${strategy.budget_basis === "HEURISTIC_STARTING_TEST" ? "heuristic starting-test" : "historically-derived"} daily budget of ${strategy.budget_daily} exceeds the safe maximum suggested budget of ${MAX_SUGGESTED_DAILY_BUDGET} without stronger evidence.`,
    });
  }
  if (strategy.budget_daily > MAX_EXECUTABLE_DAILY_BUDGET) {
    errors.push({
      field: "budget_daily",
      message: `A daily budget of ${strategy.budget_daily} exceeds the hard maximum executable daily budget of ${MAX_EXECUTABLE_DAILY_BUDGET} — this cannot be created (or executed) above this limit regardless of basis.`,
    });
  }
  return errors;
}

// Step 5, requirement 5: a HEURISTIC_STARTING_TEST budget above the safe
// suggested maximum is a MECHANICAL, deterministic correction — clamp it
// before validation ever runs rather than treating it as a genuine
// unresolved business issue (there is nothing for the user to decide
// here; the number is simply capped). budget_basis is left unchanged so
// the customer-facing "as a conservative starting test budget" framing
// still applies correctly to the capped number.
export function capHeuristicBudget(strategy) {
  if (strategy.budget_basis !== "HEURISTIC_STARTING_TEST") return strategy;
  if (typeof strategy.budget_daily !== "number" || strategy.budget_daily <= MAX_SUGGESTED_DAILY_BUDGET) return strategy;
  return { ...strategy, budget_daily: MAX_SUGGESTED_DAILY_BUDGET };
}

// A real, non-negotiable literal check — does the user's own message text
// actually contain the claimed number? Deliberately mechanical, not
// semantic: USER_PROVIDED is a trust-bypassing claim (uncapped by
// checkBudgetPolicy), so the model's own say-so can never be enough.
function userMessageContainsAmount(userMessage, amount) {
  if (!userMessage || typeof amount !== "number" || !Number.isFinite(amount)) return false;
  const normalized = userMessage.replace(/[,\s]/g, "");
  return normalized.includes(String(Math.trunc(amount)));
}

// Only fires when THIS call is the one actually asserting USER_PROVIDED
// (checked against the raw, pre-merge input) — a revision that silently
// carries a prior, ALREADY-verified USER_PROVIDED budget forward unchanged
// must not be re-flagged just because this turn's message doesn't happen
// to repeat a number it already established validly earlier.
export function verifyUserProvidedBudget(rawStrategy, mergedStrategy, userMessage) {
  if (rawStrategy.budget_basis !== "USER_PROVIDED") return mergedStrategy;
  if (userMessageContainsAmount(userMessage, mergedStrategy.budget_daily)) return mergedStrategy;
  return { ...mergedStrategy, budget_basis: "HEURISTIC_STARTING_TEST" };
}

// Step 4/5 — goal alignment. clearEcommerceWithPurchaseTracking: true only
// when BOTH a real commerce platform is connected AND a Meta Pixel was
// actually resolvable for this ad account — two independently-checkable
// facts, never the model's own claim.
export function checkGoalAlignmentPolicy(strategy, businessSignals = {}) {
  const errors = [];
  if (!businessSignals.clearEcommerceWithPurchaseTracking) return errors;

  if (strategy.recommended_objective === "OUTCOME_TRAFFIC") {
    const ga = strategy.goal_alignment;
    if (!ga || ga.recommendation_differs_from_literal_request !== true) {
      errors.push({
        field: "goal_alignment",
        message: "This is a connected e-commerce business with real purchase tracking — a Traffic objective must not be recommended silently. Set goal_alignment.recommendation_differs_from_literal_request=true, recommend OUTCOME_SALES instead, and offer Traffic as an explicit alternative in unresolved_questions only if the user genuinely wants pure visits.",
      });
    }
  }
  return errors;
}

// Step 5 — Sales consistency: an OUTCOME_SALES recommendation must reason
// about purchases/CPA/ROAS/conversion volume/revenue, never reach/
// engagement/cheap clicks as the primary framing. A loose, deliberately
// non-exhaustive keyword check — not a semantic judge of persuasiveness,
// just a guard against the specific failure mode the spec names.
const SALES_FOCUS_WORDS = /\b(purchase|purchases|conversion|conversions|revenue|roas|cpa|checkout|order|orders|sales)\b/i;
const CHEAP_TRAFFIC_FOCUS_WORDS = /\b(reach|engagement|cheap clicks?|impressions|awareness|visits)\b/i;
export function checkSalesConsistencyPolicy(strategy) {
  const errors = [];
  if (strategy.recommended_objective !== "OUTCOME_SALES") return errors;
  const summary = strategy.reasoning_summary || "";
  const mentionsSalesFraming = SALES_FOCUS_WORDS.test(summary);
  const mentionsOnlyCheapTrafficFraming = CHEAP_TRAFFIC_FOCUS_WORDS.test(summary) && !mentionsSalesFraming;
  if (!mentionsSalesFraming || mentionsOnlyCheapTrafficFraming) {
    errors.push({
      field: "reasoning_summary",
      message: "recommended_objective is OUTCOME_SALES, but reasoning_summary doesn't frame the recommendation around purchases/CPA/ROAS/conversion volume/revenue — a Sales recommendation must reason about completed purchases, not reach, engagement, or cheap clicks.",
    });
  }
  return errors;
}

// Live bug (round after the per-turn single-call gate): a structurally
// sound OUTCOME_SALES strategy (valid objective/audience/budget/assets/
// placements — everything a business decision) was rejected purely
// because reasoning_summary's WORDING didn't frame it around purchases/
// CPA/ROAS/revenue. That's a presentation defect, not an unresolved
// business issue — the model had already made the right call, it just
// phrased the explanation for reach/engagement instead of sales.
// Rejecting it burned the model's one generation attempt (Step 7) on
// something purely mechanical, driving exactly the kind of build_strategy
// retry the per-turn gate now caps.
//
// repairSalesReasoningSummary deterministically REGENERATES the summary
// from the strategy's own already-validated fields (optimization_event,
// evidence_used) — never another LLM call, same "mechanical fix before
// validation" principle as normalizeStrategyEnumAliases/deriveCtaIfMissing/
// capHeuristicBudget in strategySchema.js/policy.js. Called by
// strategyBuilder.js ONLY when checkSalesConsistencyPolicy is the SOLE
// failing check — every other business decision must already be sound.
const OUTCOME_SALES_EVENT_LABEL = {
  PURCHASE: "purchases",
  ADD_TO_CART: "add-to-cart conversions",
  LEAD: "lead conversions",
  COMPLETE_REGISTRATION: "registration conversions",
};
export function repairSalesReasoningSummary(strategy) {
  const evidenceClause = Array.isArray(strategy.evidence_used) && strategy.evidence_used.length
    ? ` — using ${strategy.evidence_used.join("; ")}`
    : "";
  if (strategy.optimization_event === "PURCHASE") {
    return `This strategy is optimized to drive purchases, not just reach or clicks${evidenceClause}: the goal is a strong volume of completed purchases at an efficient cost-per-acquisition (CPA) and a healthy return on ad spend (ROAS), maximizing revenue and overall conversion efficiency.`;
  }
  const eventLabel = OUTCOME_SALES_EVENT_LABEL[strategy.optimization_event] || "conversions";
  return `This strategy is optimized to drive ${eventLabel}, not just reach or clicks${evidenceClause}: the goal is a strong conversion volume at an efficient cost-per-acquisition (CPA) and a healthy return on ad spend (ROAS), maximizing revenue and overall conversion efficiency.`;
}

// Live bug: a live V2 test asked the model to choose the "exact best"
// creative from the account's real recent content. Nothing forced a real
// get_business_snapshot call first (see CREATIVE_SELECTION_INTENT_PATTERNS
// in orchestrator/index.js for the chat-level fix), and separately,
// nothing here stopped a strategy from claiming a piece of creative was
// "high performing" or had "proven effectiveness" when the business
// snapshot never actually returned real engagement/performance numbers
// for it. This is the backend-enforced half of that fix: a strategy is
// REJECTED if its reasoning/creative description makes a performance
// claim the snapshot's own data doesn't support — the same "policy can
// reject the model's prose regardless of how convincing it reads"
// principle as checkSalesConsistencyPolicy above, just grounded against
// real snapshot facts instead of a fixed keyword list.
const PERFORMANCE_CLAIM_WORDS = /\b(high(?:est)?[- ]?(?:performing|engagement)|top[- ]?performing|best[- ]?performing|proven (effectiveness|track record)|strong engagement|great engagement|top performer)\b/i;
export function checkCreativeGroundingPolicy(strategy, snapshot) {
  const errors = [];
  const texts = [strategy.reasoning_summary, strategy.creative_strategy?.description].filter((t) => typeof t === "string");
  if (!texts.some((t) => PERFORMANCE_CLAIM_WORDS.test(t))) return errors;

  const allContent = [
    ...(snapshot?.recentContent?.facebookPosts?.items || []),
    ...(snapshot?.recentContent?.instagramPosts?.items || []),
  ];
  // If a SPECIFIC piece of content was selected (explicit_action mode),
  // the performance claim must be grounded in THAT item's own real
  // engagement data — not just any item in the snapshot having numbers.
  const selectedId = strategy.mode === "explicit_action" ? strategy.content_selector?.confirmedId : null;
  const selectedItem = selectedId ? allContent.find((i) => i.id === selectedId) : null;
  const hasRealEvidence = selectedItem ? selectedItem.engagement?.status === "exists" : allContent.some((i) => i.engagement?.status === "exists");

  if (!hasRealEvidence) {
    errors.push({
      field: "reasoning_summary",
      message: 'The strategy describes a piece of creative as high-performing / proven ("high engagement," "proven effectiveness," etc.), but no real engagement or performance data exists in the current business snapshot for it — that claim isn\'t supported by any actual fact. Either select content that genuinely has engagement data, or reframe the reasoning around clearly-labeled non-performance factors (e.g. "Based on content relevance and format...") instead of claiming it performs best.',
    });
  }
  return errors;
}

// Deterministic, non-LLM regeneration paired with checkCreativeGroundingPolicy
// above — same "mechanical fix before validation" principle as
// repairSalesReasoningSummary: when the ONLY problem is an unsupported
// performance claim, replace it with the honest, clearly-labeled heuristic
// framing the spec requires, rather than burning the model's one
// generation attempt on a rejection it can't actually fix with more facts
// (the facts genuinely don't exist).
export function repairCreativeReasoningForMissingEvidence(strategy) {
  const evidenceClause = Array.isArray(strategy.evidence_used) && strategy.evidence_used.length
    ? ` — using ${strategy.evidence_used.join("; ")}`
    : "";
  return `Based on content relevance and format${evidenceClause}, this is the most suitable existing creative to use right now. No real engagement or performance data is currently available in the account to rank content by results, so this selection is based on recency, relevance, and format suitability rather than proven performance.`;
}

// Step 4/5 — Audience quality. Same "generic audience needs a real reason"
// principle: All genders 18-65 is Meta's own widest possible range, not a
// considered choice.
export function isGenericAudience(strategy) {
  return strategy.gender === "ALL" && strategy.age_min <= 18 && strategy.age_max >= 65;
}
export function checkAudienceQualityPolicy(strategy, businessSignals = {}) {
  const errors = [];
  if (strategy.mode === "explicit_action" || !isGenericAudience(strategy)) return errors;

  if (typeof strategy.audience_reasoning !== "string" || !strategy.audience_reasoning.trim()) {
    errors.push({
      field: "audience_reasoning",
      message: "A fully generic audience (all genders, 18-65) requires an explicit audience_reasoning explaining why no narrower targeting applies.",
    });
  }
  if (strategy.audience_strategy === "HEURISTIC" && businessSignals.hasStrongerAudienceEvidence) {
    errors.push({
      field: "audience_strategy",
      message: "A fully generic audience with basis HEURISTIC isn't justified — real data exists that could inform this (connected store/product data or this ad account's own campaign history). Use STORE_DATA, PRODUCT_CATEGORY, ACCOUNT_HISTORY, or META_PERFORMANCE and narrow the audience using that evidence instead.",
    });
  }
  return errors;
}

// Step 5 — Revision quality (Acceptance Test C/D): "the revised strategy
// must actually reconsider" the fields the user asked to change, not
// return the same strategy with cosmetic prose only. revise_strategy's
// `requestedChanges` parameter IS a partial strategy object containing
// ONLY the fields actually changing (same "send only what's different"
// contract as the rest of a revision) — the fact a scalar field's key
// appears there at all means the caller is claiming to reconsider it, so
// this compares each such field's NEW value against the PRIOR strategy's
// value. A field NOT present in requestedChanges is never checked here
// (unrelated fields are SUPPOSED to carry forward unchanged — see
// strategyBuilder.js's merge).
export const COMPARABLE_SCALAR_FIELDS = new Set([
  "recommended_objective", "optimization_event", "conversion_location", "audience_strategy",
  "gender", "age_min", "age_max", "targeting_approach", "placements", "budget_daily",
  "budget_basis", "bid_strategy", "cta",
]);
export function checkRevisionSubstantive({ priorStrategy, newStrategy, requestedChanges = {} }) {
  const errors = [];
  const unchanged = [];
  for (const field of Object.keys(requestedChanges)) {
    if (!COMPARABLE_SCALAR_FIELDS.has(field)) continue; // locations/countries/creative_strategy are array/object fields — not compared here
    const before = priorStrategy?.[field];
    const after = newStrategy?.[field];
    if (before === after) unchanged.push(field);
  }
  if (unchanged.length) {
    errors.push({
      field: "requestedChanges",
      message: `The user asked to reconsider ${unchanged.join(", ")}, but the revised strategy left ${unchanged.length > 1 ? "those fields" : "that field"} exactly as they were — a revision must actually change the value or explicitly justify keeping it (real evidence in reasoning_summary/evidence_used for why the current value is still correct), never cosmetic prose only.`,
    });
  }
  return errors;
}

// Turns raw validation/policy errors into a SINGLE clean, customer-safe
// unresolved-issue description — Step 7: V2 gets exactly ONE generation
// attempt, then either a full recommendation or one structured, plain-
// language explanation of the real business issue blocking it. Never a
// repair-guidance loop for the model to retry against (that's the old
// planner's pattern V2 deliberately does not repeat) — deterministic
// normalization (enum aliases, CTA default, heuristic budget cap) already
// ran before validation, so anything reaching here is a genuine unresolved
// business decision, not a mechanical slip.
export function buildUnresolvedIssue(errors) {
  if (!errors.length) return null;
  const primary = errors[0];
  return {
    field: primary.field || null,
    issue: primary.message,
    allIssues: errors.map((e) => ({ field: e.field || null, issue: e.message })),
  };
}

// Backend gate for meta_expert_v2.execute_strategy — checked in
// server/orchestrator/index.js BEFORE the tool is even dispatched, same
// principle as V1's checkExecutionApprovalGate but independent (V2 has its
// own active-strategy lookup, see strategyStore.js's
// getActiveStrategyForConversation).
const EXECUTION_APPROVAL_PATTERN = /\b(approve|approved|proceed|run it|launch it|go ahead|do it|confirm(ed)?|create it|build it|make it live|start it)\b|\byes[,.]?\s+(create|launch|run|build|do)\s+it\b/i;
export function messageIndicatesExecutionApproval(text) {
  return typeof text === "string" && EXECUTION_APPROVAL_PATTERN.test(text);
}

export function fingerprintStrategy(strategy = {}) {
  const normalized = {};
  for (const field of COMPARABLE_SCALAR_FIELDS) normalized[field] = strategy[field] ?? null;
  normalized.locations = [...(strategy.locations || [])].sort();
  normalized.countries = [...(strategy.countries || [])].sort();
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}
