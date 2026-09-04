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

// Live bug (round 31): the check above only ever catches ONE direction of
// substitution — silently downgrading FROM sales TO traffic. It has no
// symmetric check for the opposite: the user's own message literally
// asked for traffic/visitors, and the model recommended something else
// entirely (usually Sales) with zero acknowledgment. Live report: "I want
// more visitors on my website" -> Website Purchases (OUTCOME_SALES) was
// recommended, the "Why" section argued for purchases, and the literal
// ask was never once mentioned. "Recommending against a stated goal is
// fine. Silently substituting it is not" (the user's own framing,
// implemented directly). Deliberately NOT gated behind
// clearEcommerceWithPurchaseTracking like the check above — a literal
// traffic-only request deserves acknowledgment regardless of how
// confidently the backend can classify the business, and gating it the
// same way would have missed this exact live case if store data wasn't
// unambiguously "exists" yet. Checked against the RAW userMessage, never
// strategy.business_goal (the model's own paraphrase of what the user
// asked for) — same reason userMessageContainsAmount above never trusts
// the model's own budget claim.
const LITERAL_TRAFFIC_WORDS = /\b(traffic|visitors?|website visits?)\b/i;
const LITERAL_SALES_WORDS = /\b(sales?|purchases?|buy(?:ing)?|revenue|conversions?|orders?|checkout)\b/i;
export function checkLiteralGoalSubstitutionPolicy(strategy, userMessage) {
  const errors = [];
  if (typeof userMessage !== "string") return errors;
  const literalTrafficOnly = LITERAL_TRAFFIC_WORDS.test(userMessage) && !LITERAL_SALES_WORDS.test(userMessage);
  if (!literalTrafficOnly || strategy.recommended_objective === "OUTCOME_TRAFFIC") return errors;
  const ga = strategy.goal_alignment;
  if (!ga || ga.recommendation_differs_from_literal_request !== true) {
    errors.push({
      field: "goal_alignment",
      message: `The user's own message asked for traffic/visitors specifically, but the recommended objective is "${strategy.recommended_objective}" — recommending a different objective than what was literally asked for is fine, but it must be acknowledged, never substituted silently. Set goal_alignment.literal_request/likely_business_outcome/recommendation_differs_from_literal_request=true so the customer-facing recommendation explicitly says what was asked for, what's being recommended instead, and why — e.g. "you asked for traffic; for a store I'd recommend purchases instead, because X — want traffic anyway?"`,
    });
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

// Live bug (round 24): a strategy was hard-rejected at the STRUCTURAL
// stage for "Missing required field \"reasoning_summary\"" — this
// happened specifically right after the model recovered from a wrong-
// tool attempt (execute_strategy with no active strategy -> correctly
// falling back to build_strategy), where it appears to deprioritize a
// field it may have already reasoned through moments earlier. Same
// principle repairSalesReasoningSummary above already established for a
// WEAK/generic reasoning_summary — this system already treats the field
// as a templated restatement of the strategy's own already-decided
// facts (objective, optimization event, evidence_used), not a unique
// independent judgment call — so a genuinely MISSING summary is just the
// most extreme case of "wrong," fixable the same mechanical way. Runs
// BEFORE structural validation (unlike the WEAK-text repairs above,
// which only fire once every other check has already passed) so the
// hard "missing required field" rejection never has anything to fire on
// in the first place.
const OUTCOME_REASONING_FALLBACK_LABEL = {
  OUTCOME_TRAFFIC: "driving qualified traffic to the site",
  OUTCOME_LEADS: "generating qualified leads",
  OUTCOME_ENGAGEMENT: "growing meaningful engagement",
  OUTCOME_AWARENESS: "building brand awareness with the target audience",
  OUTCOME_APP_PROMOTION: "driving app installs",
};
export function deriveReasoningSummaryIfMissing(strategy) {
  if (typeof strategy.reasoning_summary === "string" && strategy.reasoning_summary.trim()) return strategy;
  if (strategy.recommended_objective === "OUTCOME_SALES") {
    return { ...strategy, reasoning_summary: repairSalesReasoningSummary(strategy) };
  }
  const evidenceClause = Array.isArray(strategy.evidence_used) && strategy.evidence_used.length
    ? ` — using ${strategy.evidence_used.join("; ")}`
    : "";
  const label = OUTCOME_REASONING_FALLBACK_LABEL[strategy.recommended_objective] || "the stated business goal";
  return { ...strategy, reasoning_summary: `This strategy is built around ${label}${evidenceClause}.` };
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
// Exported (not just used locally) — orchestrator/index.js reuses this
// SAME regex to guard the model's own FINAL CHAT REPLY text too (the
// currency-symbol/false-completion-claim class of bug: a structured-field
// check alone doesn't stop the model from editorializing "this is your
// best-performing post!" in its own prose on top of an honest, compliant
// strategy). One definition of "a performance claim," used at both
// layers, never two regexes drifting apart.
export const PERFORMANCE_CLAIM_WORDS = /\b(high(?:est)?[- ]?(?:performing|engagement)|top[- ]?performing|best[- ]?performing|proven (effectiveness|track record)|strong engagement|great engagement|top performer)\b/i;
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

// Live bug (creative-selection follow-up): a live test's snapshot had
// Facebook post fetching FAIL and no usable Instagram content — yet the
// strategy still claimed to select "an existing Facebook/Instagram
// creative," effectively presenting a WooCommerce product as if it were
// real, fetched Meta content. checkCreativeGroundingPolicy above only
// guards PERFORMANCE claims ("high engagement"); this guards the
// EXISTENCE claim itself — creative_strategy.source can only claim
// EXISTING_PAGE_POST/EXISTING_INSTAGRAM_POST when that platform's content
// actually came back usable in the snapshot. Deliberately NOT
// auto-repaired like the two checks above: which specific product to
// recommend instead is a real business decision (which one is actually
// relevant), not a mechanical wording fix — so this returns a genuine
// rejection whose message tells the model exactly what to do instead
// (PRODUCT_IMAGE, grounded in a real product), matching the same
// "genuine business decision -> real unresolved issue" principle as an
// ambiguous Pixel.
function hasUsableContent(section) {
  return section?.status === "exists" && Array.isArray(section.items) && section.items.length > 0;
}
export function checkCreativeSourceAvailabilityPolicy(strategy, snapshot) {
  const errors = [];
  const source = strategy.creative_strategy?.source;
  if (!source) return errors;
  const fbUsable = hasUsableContent(snapshot?.recentContent?.facebookPosts);
  const igUsable = hasUsableContent(snapshot?.recentContent?.instagramPosts);
  if (source === "EXISTING_PAGE_POST" && !fbUsable) {
    errors.push({
      field: "creative_strategy",
      message: `creative_strategy claims an existing Facebook post as the creative, but no usable Facebook post content exists in the current snapshot (status: ${snapshot?.recentContent?.facebookPosts?.status || "unknown"}) — never present a WooCommerce/Shopify product, or anything else, as if it were an existing Facebook creative. Set source to PRODUCT_IMAGE (or another non-existing-post source) and recommend a NEW product-led creative grounded in a real product from the business snapshot instead — say plainly: "I couldn't verify a usable existing Reel/post, so I recommend creating a new product-led creative around [product] based on WooCommerce relevance."`,
    });
  }
  if (source === "EXISTING_INSTAGRAM_POST" && !igUsable) {
    errors.push({
      field: "creative_strategy",
      message: `creative_strategy claims an existing Instagram post/Reel as the creative, but no usable Instagram content exists in the current snapshot (status: ${snapshot?.recentContent?.instagramPosts?.status || "unknown"}) — never present a WooCommerce/Shopify product, or anything else, as if it were an existing Instagram creative. Set source to PRODUCT_IMAGE (or another non-existing-post source) and recommend a NEW product-led creative grounded in a real product from the business snapshot instead — say plainly: "I couldn't verify a usable existing Reel/post, so I recommend creating a new product-led creative around [product] based on WooCommerce relevance."`,
    });
  }
  return errors;
}

// Live bug (creative-selection follow-up #2): checkCreativeSourceAvailabilityPolicy
// above only guards a source the model already CLAIMED — it does nothing
// when the model never attempted the platform the user literally asked
// for in the first place, so "I want an Instagram post" could silently
// return PRODUCT_IMAGE with zero rejection. Unlike budget
// (verifyUserProvidedBudget) and objective
// (checkLiteralGoalSubstitutionPolicy), nothing compared the user's own
// words against creative_strategy.source. Deliberately checked against the
// RAW userMessage, same discipline as those two. Only fires when the
// requested platform's content is ACTUALLY usable (hasUsableContent) —
// when it genuinely isn't, checkCreativeSourceAvailabilityPolicy already
// owns forcing a switch away from it, and requiring both at once (this
// check demanding the existing-post source, that one rejecting it as
// unusable) would deadlock. The genuinely-unusable case is handled
// separately, mechanically, by repairCreativeDescriptionForUnavailableLiteralSource
// below — never by a rejection, since no retry can fix real data
// unavailability.
const LITERAL_INSTAGRAM_WORDS = /\b(instagram|ig\s*post|ig\s*reel|reels?)\b/i;
// Live bug (follow-up): requiring the literal verb "boost" missed the far
// more common real phrasing "use one of my facebook page posts as the
// ad" — no "boost", and "page" between "facebook" and "posts" also broke
// an earlier, even narrower "facebook post" (singular, adjacent) attempt.
// Matches "facebook", then up to 2 intervening words (e.g. "page", "top"),
// then "post"/"posts" — covers "facebook post", "facebook page post(s)",
// "my recent facebook posts", etc.
const LITERAL_FACEBOOK_POST_WORDS = /\bfacebook\b(?:\s+\S+){0,2}?\s+posts?\b|\bfb\b(?:\s+\S+){0,2}?\s+posts?\b/i;
// "instead of"/"rather than" alongside a platform mention means the user
// is DECLINING that platform, not requesting it — "use a product image
// instead of the Facebook post" mentions Facebook while explicitly ruling
// it out. A real, pre-existing test hit exactly this once the check above
// was broadened to a bare mention. Message-level (not proximity-based) —
// deliberately mechanical like every other literal check in this file,
// not a semantic negation parser.
const DECLINE_WORDS = /\b(instead of|rather than)\b/i;
export function checkLiteralCreativeSourceSubstitutionPolicy(strategy, userMessage, snapshot) {
  const errors = [];
  if (typeof userMessage !== "string") return errors;
  const source = strategy.creative_strategy?.source;
  if (!source) return errors;

  if (DECLINE_WORDS.test(userMessage)) return errors;

  if (LITERAL_INSTAGRAM_WORDS.test(userMessage) && source !== "EXISTING_INSTAGRAM_POST" && hasUsableContent(snapshot?.recentContent?.instagramPosts)) {
    errors.push({
      field: "creative_strategy.source",
      message: "The user's own message literally asked for an Instagram post/Reel as the creative, and usable Instagram content exists in the current business snapshot — set creative_strategy.source to EXISTING_INSTAGRAM_POST and select from that real content. Never substitute a WooCommerce/Shopify product silently when the requested platform's content is genuinely available.",
    });
  }
  if (LITERAL_FACEBOOK_POST_WORDS.test(userMessage) && source !== "EXISTING_PAGE_POST" && hasUsableContent(snapshot?.recentContent?.facebookPosts)) {
    errors.push({
      field: "creative_strategy.source",
      message: "The user's own message literally asked to boost an existing Facebook post as the creative, and usable Facebook post content exists in the current business snapshot — set creative_strategy.source to EXISTING_PAGE_POST and select from that real content. Never substitute a WooCommerce/Shopify product silently when the requested platform's content is genuinely available.",
    });
  }
  return errors;
}

// Deterministic, non-LLM regeneration — same "mechanical fix, don't burn
// the model's one generation attempt on something no amount of retrying
// can change" principle as repairCreativeReasoningForMissingEvidence
// above. Pairs with checkLiteralCreativeSourceSubstitutionPolicy: when the
// user literally asked for a platform's existing content and that
// platform's content genuinely ISN'T usable (hasUsableContent is false),
// the model has no way to comply — but silently falling back to
// PRODUCT_IMAGE with zero mention of what was asked is still the live bug
// being fixed (same "recommending something else is fine, substituting it
// silently is not" principle as checkLiteralGoalSubstitutionPolicy).
// Prepends an honest, factual acknowledgment sentence citing the real
// reason (snapshot.recentContent.*.reason — see businessSnapshot.js)
// instead of relying on the model to volunteer it.
export function repairCreativeDescriptionForUnavailableLiteralSource(strategy, userMessage, snapshot) {
  if (typeof userMessage !== "string") return strategy;
  const source = strategy.creative_strategy?.source;
  if (!source || source === "EXISTING_INSTAGRAM_POST" || source === "EXISTING_PAGE_POST") return strategy;

  const wantsInstagram = LITERAL_INSTAGRAM_WORDS.test(userMessage) && !hasUsableContent(snapshot?.recentContent?.instagramPosts);
  const wantsFacebookPost = !wantsInstagram && LITERAL_FACEBOOK_POST_WORDS.test(userMessage) && !hasUsableContent(snapshot?.recentContent?.facebookPosts);
  if (!wantsInstagram && !wantsFacebookPost) return strategy;

  const platform = wantsInstagram ? "an Instagram post/Reel" : "an existing Facebook post";
  const reason = wantsInstagram ? snapshot?.recentContent?.instagramPosts?.reason : snapshot?.recentContent?.facebookPosts?.reason;
  const description = strategy.creative_strategy.description || "";
  if (description.startsWith("You asked for")) return strategy;
  const acknowledgment = `You asked for ${platform} as the creative, but I couldn't find usable content for that right now${reason ? ` (${reason})` : ""}. `;
  return { ...strategy, creative_strategy: { ...strategy.creative_strategy, description: acknowledgment + description } };
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
// Live bug (round 20): the model's own execute_strategy-blocked message
// suggests exactly "Please confirm your approval by stating 'approve' or
// 'run it.'" — but a natural short reply of just "run" (no "it") doesn't
// match "run it" above, so a genuinely intended approval was silently
// blocked, leaving the user stuck re-presenting the same recommendation.
// Whole-message-only (never mid-sentence) so a real word like "run" or
// "yes" used naturally elsewhere in a longer message ("how does this
// run?") is never mistaken for approval — only when it's the ENTIRE
// reply, exactly the shape a quick-reply chip or a terse human answer
// takes.
const BARE_APPROVAL_WORD_PATTERN = /^\s*(run|yes|ok|okay|sure)[.!]?\s*$/i;
export function messageIndicatesExecutionApproval(text) {
  if (typeof text !== "string") return false;
  return EXECUTION_APPROVAL_PATTERN.test(text) || BARE_APPROVAL_WORD_PATTERN.test(text);
}

export function fingerprintStrategy(strategy = {}) {
  const normalized = {};
  for (const field of COMPARABLE_SCALAR_FIELDS) normalized[field] = strategy[field] ?? null;
  normalized.locations = [...(strategy.locations || [])].sort();
  normalized.countries = [...(strategy.countries || [])].sort();
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}
