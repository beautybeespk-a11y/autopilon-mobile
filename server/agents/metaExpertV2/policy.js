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

// Round 35 (live bug — Meta error 100/3858720: a sales campaign whose
// creative is an existing organic post needs a real destination URL, and
// nothing ever asked for one).
//
// Round 36 fix (production deadlock): a real user routinely answers
// several open questions in one message ("2, ye use the same url, budget
// 600") — budget's USER_MESSAGE_BUDGET_PATTERN and creative's
// matchCreativeCandidateId already tolerate this (they scan the whole
// message for their signal), but this field's original affirmation check
// required the ENTIRE message to be nothing but a bare word, so any
// compound reply never matched and the question could never close.
// Fixed the same way matchCreativeCandidateId layers its own matching:
// an UNAMBIGUOUS phrase that specifically names reusing "the url/link" is
// safe to recognize ANYWHERE in the message; a bare generic word (yes/
// correct/right/...) still only counts when it IS the entire message —
// embedding those would risk misreading a "yes" used naturally elsewhere
// in a longer reply, the same reason BARE_APPROVAL_WORD_PATTERN and
// creativeResolution.js's PENDING_CREATIVE_AFFIRMATION_PATTERN stay
// whole-message-only.
const URL_AFFIRMATION_PATTERN = /^\s*(yes|yep|yup|correct|right|confirmed?|use that|use it|that works|that one|that'?s right)[.!]?\s*$/i;
const EMBEDDED_URL_REUSE_PATTERN = /\b(use (?:the )?same (?:url|link|website)|use that (?:url|link|website)|same (?:url|link|website)|that url|that link)\b/i;
export function messageAffirmsSuggestedUrl(userMessage) {
  if (typeof userMessage !== "string") return false;
  return URL_AFFIRMATION_PATTERN.test(userMessage) || EMBEDDED_URL_REUSE_PATTERN.test(userMessage);
}

// Case/protocol/trailing-slash insensitive, but still a real literal
// substring check — same "never fuzzy/semantic" principle as
// userMessageContainsAmount above and creativeResolution.js's
// userMessageContainsText, applied to a URL a user typed in plain chat.
function normalizeUrlForComparison(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return trimmed || null;
}
// Exported (round 40) — the per-user-defaults feature (below) reuses this
// exact literal-substring check to decide whether a resolved destination_url
// is safe to LEARN as a lasting default, same discipline as everywhere else
// a value gets persisted from a chat message: never fuzzy, never the
// model's own claim, only what the user's raw words actually contain.
export function userMessageContainsUrl(userMessage, url) {
  if (typeof userMessage !== "string") return false;
  const normalizedTarget = normalizeUrlForComparison(url);
  if (!normalizedTarget) return false;
  return userMessage.toLowerCase().includes(normalizedTarget);
}

// Round 40 — per-user Meta defaults (ad account, Facebook Page, Pixel,
// destination URL). Live incident this exists to prevent from happening a
// SECOND time, at 4x the blast radius: a model-supplied Pixel id was once
// written as the permanent account-level default with no real user
// confirmation (round 14/33), so every campaign built afterward silently
// pointed at the wrong dataset. The fix at the time was scoped to pixel
// only, and relied on ONE trusted caller (the orchestrator's own
// deterministic pre-loop) always being the thing that set
// explicitAssetChanges — but explicitAssetChanges is ALSO a plain,
// model-settable tool parameter (metaExpertV2.js), passed straight through
// to the resolver with no independent verification against what the user
// actually typed. A model that sets it on an ordinary tool call — trusting
// only the tool description's prose ("ONLY when the user's own words...")
// — has always been able to reach the exact same write path. That's a
// prompt instruction standing in for a deterministic gate, which round 38's
// own design principle already named as the thing that must never happen.
//
// userMessageConfirmsAssetChoice is the independent re-check applied at
// EVERY default-write point (ad account/page/pixel — see
// assetResolution.js — and destination_url — see strategyBuilder.js),
// regardless of which caller resolved the value or why: a value is only
// ever LEARNED as a lasting default when it is independently found, in
// this exact turn's raw message, either as its real numeric id (a digit
// run — same discipline as the pixel auto-revise pre-loop's own matcher)
// or as its real, Meta-confirmed name (a case-insensitive substring — same
// looseness resolvePageId's own findPageByName already applies when
// resolving, not just when persisting). This is stricter than one-time
// resolution trust (unchanged, out of scope here) — appropriate, since a
// default silently affects every FUTURE conversation, not just this one.
export function userMessageConfirmsAssetChoice(userMessage, { id, name } = {}) {
  if (typeof userMessage !== "string") return false;
  if (id) {
    const digitRuns = userMessage.match(/\d+/g) || [];
    if (digitRuns.includes(String(id).replace(/^act_/, ""))) return true;
  }
  if (typeof name === "string" && name.trim() && userMessage.toLowerCase().includes(name.trim().toLowerCase())) return true;
  return false;
}

// Round 36 fix: an explicit http(s) URL typed anywhere in the message is
// an unambiguous, never-invented signal on its own — lifted verbatim from
// the user's own text, so it needs no suggestedUrl/store connection to be
// trustworthy. Used by the orchestrator's auto-revise pre-loop to extract
// a real candidate the same way deriveBudgetFromUserMessageIfMissing
// extracts a number; verifyDestinationUrl below independently re-checks
// whatever gets proposed against the SAME raw message before it's ever
// trusted, so a wrong or partial extraction here can never ship on its
// own say-so.
const USER_MESSAGE_URL_PATTERN = /https?:\/\/[^\s,;()"'<>]+/i;
export function extractUrlFromMessage(userMessage) {
  if (typeof userMessage !== "string") return null;
  const match = USER_MESSAGE_URL_PATTERN.exec(userMessage);
  return match ? match[0].replace(/[.,;:!?]+$/, "") : null;
}

// Only fires when THIS call is the one actually asserting a destination_url
// (checked against the RAW, pre-merge requestedChanges — same "explicit
// this turn" signal verifyUserProvidedBudget/explicitAssetChanges use).
//
// Round 36 fix (production deadlock): the model is instructed to omit
// unchanged fields, but nothing stops it from re-asserting destination_url
// on a LATER, unrelated call (bundled with an audience/budget change, or
// just restating known state) — and the original version below treated
// every such re-assertion as a brand-new, unverified claim, clearing an
// ALREADY-CONFIRMED value to null the moment that turn's own message
// didn't happen to repeat the URL or a fresh affirmation. That silently
// undid a real, previously-verified answer and re-opened the identical
// question forever — the exact deadlock reported in production (budget/
// Pixel/creative all resolved on the same messages; destination_url never
// moved). priorUrl (the prior STORED value — never trusted unless it
// already passed this same function once) fixes this the same way
// verifyUserProvidedBudget only ever downgrades budget_basis and never
// wipes budget_daily itself: re-asserting the SAME already-verified value
// is carried forward untouched, never re-flagged just because this turn's
// message doesn't happen to repeat it. Only a call asserting a genuinely
// DIFFERENT value still goes through full verification below, and a claim
// that doesn't independently verify is cleared entirely (never partially
// trusted) — the caller's own unresolved_questions requirement re-asks
// from there, exactly like a downgraded USER_PROVIDED budget claim
// re-opens checkBudgetPolicy.
// suggestedUrl: the ONE candidate this codebase can ever propose on its
// own (the connected store's URL) — accepted without the literal string
// appearing in the message ONLY when the user's own words affirm exactly
// that suggestion (see messageAffirmsSuggestedUrl above); a manually-typed
// URL (the same one, a different one, or a correction) always needs the
// literal substring match instead.
export function verifyDestinationUrl(rawStrategy, mergedStrategy, userMessage, suggestedUrl, priorUrl) {
  const claimed = rawStrategy.destination_url;
  if (typeof claimed !== "string" || !claimed.trim()) return mergedStrategy;
  if (priorUrl && normalizeUrlForComparison(claimed) === normalizeUrlForComparison(priorUrl)) return mergedStrategy;
  const matchesSuggestionAndAffirmed = Boolean(suggestedUrl)
    && normalizeUrlForComparison(claimed) === normalizeUrlForComparison(suggestedUrl)
    && messageAffirmsSuggestedUrl(userMessage);
  if (matchesSuggestionAndAffirmed || userMessageContainsUrl(userMessage, claimed)) return mergedStrategy;
  return { ...mergedStrategy, destination_url: null };
}

// Round 37 fix — a revision of an ALREADY-EXECUTED strategy (see
// getExecutedAncestorStrategy, strategyStore.js) is blocked by default
// from ever calling execute_strategy, since that would silently create a
// SEPARATE, real second campaign rather than update the one that already
// exists — but the block must offer a real way forward, not a dead end
// (the destination-URL deadlock this codebase already had to fix once).
// One of the two ways forward IS "go ahead and create the separate
// campaign anyway" — genuinely reachable, but ONLY via an explicit,
// unambiguous reference to a NEW/SEPARATE/SECOND/ANOTHER campaign, never
// a bare "approve"/"yes" (the same generic words already used for
// ordinary approval elsewhere — reusing them here would risk exactly the
// kind of accidental-duplicate-spend collision round 36's
// destinationUrlJustAutoConfirmedThisTurn fix exists to prevent, just
// with a real campaign instead of a URL confirmation).
const SEPARATE_CAMPAIGN_ACKNOWLEDGMENT_PATTERN = /\b(create|creating|make|making|go ahead with|start|starting)\b[^.!?]{0,40}\b(a\s+)?(separate|new|second|another|duplicate)\b[^.!?]{0,20}\bcampaign\b/i;
export function messageAcknowledgesSeparateCampaign(userMessage) {
  return typeof userMessage === "string" && SEPARATE_CAMPAIGN_ACKNOWLEDGMENT_PATTERN.test(userMessage);
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

// Live incident (round 39): "create a website purchases campaign using
// one of my facebook page posts as the creative" was built with mode:
// "explicit_action" (action_type BOOST_FACEBOOK_POST) instead of mode:
// "campaign" — the model's own tool-parameter choice, with nothing in
// code ever validating it (see metaExpertV2.js's tool schema — mode is a
// plain enum with a prompt-only description of when to use each). explicit_
// action structurally has no audience/objective/destination-URL fields at
// all (see that tool's own description) and its two boost action types
// (BOOST_FACEBOOK_POST/BOOST_INSTAGRAM_POST) can't carry a link/CTA at all
// (explicitActionNeedsUnsupportedCta, strategyBuilder.js) — a request
// naming a real conversion objective was pushed down a path structurally
// incapable of representing it, then failed downstream at Meta (error
// 100/1815520 — LINK_CLICKS optimization on a post with no link) instead
// of being caught here.
//
// Two independent signals, either rejects:
//  - the RAW userMessage naming the request itself as a campaign/
//    conversion ask (EXPLICIT_ACTION_MISROUTE_PHRASE below) — never
//    strategy.business_goal (the model's own paraphrase of the request),
//    same discipline as LITERAL_SALES_WORDS above.
//  - the model's OWN structured fields already naming a conversion
//    objective (optimization_event/conversion_location/recommended_
//    objective) despite mode being explicit_action — covers the case
//    where the model set these correctly but still picked the wrong mode.
//
// EXPLICIT_ACTION_MISROUTE_PHRASE is deliberately narrower than
// LITERAL_SALES_WORDS above: a loose single-word list ("sale") matches
// "boost my post about our summer sale" exactly as readily as a genuine
// "build me a sales campaign" ask — the two are indistinguishable by word
// alone, and bouncing the first back wastes a retry on the most ordinary
// boost phrasing there is. Restricted instead to phrasing that only makes
// sense as an instruction about what to BUILD: the word "campaign" itself,
// the named objective phrase "website/online purchases" (the live
// incident's own wording), or a verb explicitly directed at a conversion
// outcome ("drive/get/generate/increase/grow sales/purchases/conversions/
// leads/sign-ups").
//
// KNOWN REMAINING GAP (documented deliberately, not attempted — same
// discipline as the primaryTextAnswer compound-message gap in
// orchestrator/index.js): a request that names audience/targeting intent
// without also naming a conversion objective or the word "campaign" — e.g.
// "boost my latest post to women 18-35 in Lahore" — still isn't caught
// here. There's no regex that reliably distinguishes a targeting
// instruction from ordinary descriptive prose about the post/audience
// without real false-positive risk, unlike "campaign" or a conversion
// verb+noun pair, which only ever appear as requests, never as content
// description. Left as a known gap for whoever hits it in production
// next.
const EXPLICIT_ACTION_MISROUTE_PHRASE = /\bcampaigns?\b|\b(website|online)\s+purchases?\b|\b(drive|get|generate|increase|grow)\s+(sales|purchases|conversions|leads|sign[\s-]?ups?)\b/i;
const EXPLICIT_ACTION_STRUCTURED_CONVERSION_EVENTS = new Set(["PURCHASE", "ADD_TO_CART", "LEAD", "COMPLETE_REGISTRATION"]);
export function checkExplicitActionModeMisroutePolicy(strategy, userMessage) {
  const errors = [];
  if (strategy.mode !== "explicit_action") return errors;
  const namesConversionRequest = typeof userMessage === "string" && EXPLICIT_ACTION_MISROUTE_PHRASE.test(userMessage);
  const structuredConversionSignal = EXPLICIT_ACTION_STRUCTURED_CONVERSION_EVENTS.has(strategy.optimization_event)
    || strategy.conversion_location === "WEBSITE"
    || ["OUTCOME_SALES", "OUTCOME_LEADS"].includes(strategy.recommended_objective);
  if (!namesConversionRequest && !structuredConversionSignal) return errors;
  errors.push({
    field: "mode",
    message: `This request names a conversion objective or campaign ask ("campaign", a conversion goal like sales/purchases/leads, or a matching optimization_event/conversion_location/recommended_objective already set) — explicit_action mode has no audience, objective, or destination-URL fields at all and cannot represent that. Rebuild this as mode: "campaign" instead, with the matching recommended_objective/optimization_event/conversion_location and full targeting — never explicit_action — whenever the request names what the ad should convert into, not just which single existing post/image/video to boost.`,
    code: "META_V2_EXPLICIT_ACTION_MODE_MISROUTE",
  });
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
    // Live bug (user-reported follow-up): the model's own free-text final
    // reply invented a vague "permissions issue" explanation instead of
    // quoting the real, specific reason — because this message never gave
    // it the real reason to quote in the first place. reasonClause below
    // is the same raw Fix-1-threaded value businessSnapshot.js captures
    // from Meta's own error, when a real one exists (not every
    // "unavailable" status has one — not_connected/no items never do).
    const reasonClause = snapshot?.recentContent?.facebookPosts?.reason ? ` The real reason: ${snapshot.recentContent.facebookPosts.reason}` : "";
    errors.push({
      field: "creative_strategy",
      message: `creative_strategy claims an existing Facebook post as the creative, but no usable Facebook post content exists in the current snapshot (status: ${snapshot?.recentContent?.facebookPosts?.status || "unknown"}).${reasonClause} Never present a WooCommerce/Shopify product, or anything else, as if it were an existing Facebook creative. Set source to PRODUCT_IMAGE (or another non-existing-post source) and recommend a NEW product-led creative grounded in a real product from the business snapshot instead — say plainly: "I couldn't verify a usable existing Reel/post, so I recommend creating a new product-led creative around [product] based on WooCommerce relevance." If you mention WHY the Facebook post isn't available, quote the real reason above verbatim — never invent or guess at a cause (e.g. never say "a permissions issue" unless that's the actual reason given).`,
    });
  }
  if (source === "EXISTING_INSTAGRAM_POST" && !igUsable) {
    const reasonClause = snapshot?.recentContent?.instagramPosts?.reason ? ` The real reason: ${snapshot.recentContent.instagramPosts.reason}` : "";
    errors.push({
      field: "creative_strategy",
      message: `creative_strategy claims an existing Instagram post/Reel as the creative, but no usable Instagram content exists in the current snapshot (status: ${snapshot?.recentContent?.instagramPosts?.status || "unknown"}).${reasonClause} Never present a WooCommerce/Shopify product, or anything else, as if it were an existing Instagram creative. Set source to PRODUCT_IMAGE (or another non-existing-post source) and recommend a NEW product-led creative grounded in a real product from the business snapshot instead — say plainly: "I couldn't verify a usable existing Reel/post, so I recommend creating a new product-led creative around [product] based on WooCommerce relevance." If you mention WHY the Instagram content isn't available, quote the real reason above verbatim — never invent or guess at a cause (e.g. never say "a permissions issue" unless that's the actual reason given).`,
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
