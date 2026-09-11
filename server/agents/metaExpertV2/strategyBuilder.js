// Meta Ads Expert V2 — the core orchestration: merge (revision only) ->
// normalize -> structural validation -> resolve assets -> quality gates ->
// store -> format recommendation. Step 7's defining rule: ONE pass, no
// automatic repair-retry loop. Deterministic normalization (enum aliases,
// CTA default, heuristic budget cap) runs before validation so a
// mechanical slip never counts as a real failure; anything that still
// fails after that is a genuine unresolved business issue, returned once
// as a single clean, customer-safe explanation — never fed back into
// another LLM attempt.
import { gatherBusinessSnapshot, getStoreCountryForFallback } from "./businessSnapshot.js";
import { resolveStrategyAssets } from "./assetResolution.js";
import { resolveCreativeSelection, formatCreativeCandidatesQuestion, formatCreativeConfirmationQuestion, formatPrimaryTextQuestion, toCreativeCandidateRefs } from "./creativeResolution.js";
import {
  validateStrategyStructure, validateStrategyAgainstContext,
  normalizeStrategyEnumAliases, deriveCtaIfMissing, deriveApprovalRequiredIfMissing,
  deriveDefaultAssetRefsIfMissing, deriveAudienceReasoningIfMissing, deriveBudgetFromUserMessageIfMissing,
  deriveCountriesFromLocationsIfMissing, deriveEmptyArrayFieldsIfMissing, PURCHASE_LIKE_EVENTS,
} from "./strategySchema.js";
import {
  checkBudgetPolicy, capHeuristicBudget, verifyUserProvidedBudget, verifyDestinationUrl,
  checkGoalAlignmentPolicy, checkLiteralGoalSubstitutionPolicy, checkSalesConsistencyPolicy, checkAudienceQualityPolicy,
  checkRevisionSubstantive, buildUnresolvedIssue, MAX_SUGGESTED_DAILY_BUDGET,
  repairSalesReasoningSummary, checkCreativeGroundingPolicy, repairCreativeReasoningForMissingEvidence,
  checkCreativeSourceAvailabilityPolicy, deriveReasoningSummaryIfMissing,
  checkLiteralCreativeSourceSubstitutionPolicy, repairCreativeDescriptionForUnavailableLiteralSource,
  checkExplicitActionModeMisroutePolicy, userMessageContainsUrl,
} from "./policy.js";
import { insertStrategy, getStoredStrategy, getMostRecentStrategyForConversation, EXECUTABLE_STATUSES } from "./strategyStore.js";
import { trace, traceEnabled } from "./diagnostics.js";
import { getConnection, learnConnectionDefault } from "../../integrations/manager.js";

const ASSET_FIELDS = ["ad_account", "facebook_page", "pixel", "catalog", "instagram_identity"];

// Same "asset fields need a higher bar than any-key-present-overrides"
// rule V1 had to learn the hard way (round 11 live bug: a revision meant
// to only change audience/budget silently reassigned the ad account and
// Page because the model happened to restate them while fixing an
// unrelated error) — built into V2 from day one instead of discovered
// after a live incident. Every OTHER field keeps the plain "any key
// present in requestedChanges overrides the prior value" merge.
function mergeForRevision(prior, requestedChanges, explicitAssetChanges) {
  const merged = { ...prior.strategy, ...requestedChanges };
  for (const field of ASSET_FIELDS) {
    if (explicitAssetChanges.has(field)) continue;
    // Live bug (round 31): this protection exists to stop an ALREADY-
    // resolved asset from being silently reassigned by a restated field
    // (round 11's original bug) — it has nothing to protect when the
    // field was left genuinely UNRESOLVED (an ambiguous Pixel with no
    // default, resolvedAssets.pixelId null — see the matching relaxation
    // in assetResolution.js's pixel resolution). Reverting merged.pixel
    // back to the prior strategy's raw field in that case discarded the
    // user's actual answer to the open question before resolution ever
    // ran, causing a real live infinite loop: the SAME unresolved-
    // question error recurring forever even after the user answered it.
    // Only pixel currently has this "stored with a real open question,
    // resolvedAssets null" state — every other asset field either
    // resolves deterministically or hard-rejects the whole build/revise
    // at build time (never reaches storage half-resolved), so this
    // exception is scoped to pixel alone.
    if (field === "pixel" && !prior.resolvedAssets?.pixelId) continue;
    merged[field] = prior.strategy[field];
  }
  // Round 33 sweep finding: content_selector isn't in ASSET_FIELDS above —
  // unlike ad_account/facebook_page/pixel/catalog, it has no single stable
  // identity of its own; its meaning depends entirely on WHICH list it's
  // resolved against (action_type for explicit_action mode,
  // creative_strategy.source for campaign mode — see resolveContentSelector
  // below and resolveCreativeSelection in creativeResolution.js). Module
  // header comments elsewhere claim this follows "the SAME ordinal/
  // confirmed-id contract" as the identity assets, but it never got the
  // matching protection: if THIS call changes action_type or
  // creative_strategy.source without also resending a fresh
  // content_selector, the plain spread above silently carries the OLD
  // selector forward — a `position` that indexed into the PREVIOUS list
  // could then silently apply against the NEW one. Fixed the same way as
  // the ASSET_FIELDS loop: discard the carried-forward selector when the
  // list it refers to changed and no fresh answer arrived this call. Both
  // consumers already degrade safely from there — resolveContentSelector
  // defaults to "most recent" (position 1), resolveCreativeSelection
  // re-asks on genuine ambiguity — neither guesses.
  const contentSelectorProvidedThisCall = requestedChanges?.content_selector !== undefined;
  if (!contentSelectorProvidedThisCall) {
    const priorActionType = prior.strategy.action_type;
    const priorSource = prior.strategy.creative_strategy?.source;
    const newActionType = merged.action_type;
    const newSource = merged.creative_strategy?.source;
    if (priorActionType !== newActionType || priorSource !== newSource) {
      delete merged.content_selector;
    }
  }
  return merged;
}

// A strategy that only reasons about a fixed piece of content ("boost my
// latest Facebook post") never invents a raw id — content_selector refers
// to it ORDINALLY against the business snapshot's own recentContent list
// (which the model already saw via get_business_snapshot), or by an id the
// snapshot already confirmed. Resolved here, once, at build time, into the
// real id the executor will actually use — never re-guessed later.
function resolveContentSelector(strategy, snapshot) {
  if (strategy.mode !== "explicit_action") return { contentId: null, contentError: null };
  const selector = strategy.content_selector || {};
  if (selector.attachedMediaRef) return { contentId: selector.attachedMediaRef, contentError: null };
  // Round 37 fix (live production report: a boosted post was picked
  // silently, no candidate list, no confirmation — five real posts
  // available). BOOST_FACEBOOK_POST/BOOST_INSTAGRAM_POST used to resolve
  // here by defaulting content_selector.position to 1 whenever unset,
  // with NO ambiguity handling and NO independent verification against
  // the user's own words at all. They now go through the SAME
  // resolveCreativeSelection (creativeResolution.js) candidate-list/
  // pendingCreative pipeline campaign mode already uses — see the caller
  // (runBuildOrRevise below), which synthesizes an EXISTING_PAGE_POST/
  // EXISTING_INSTAGRAM_POST creative_strategy for exactly these two
  // action types and folds the result's contentId in directly. This
  // function is left with only the one case that's genuinely never
  // ambiguous: a specific file the user attached in this chat.
  return { contentId: null, contentError: null };
}

function objectiveLabel(objective) {
  return {
    OUTCOME_SALES: "Website Purchases", OUTCOME_TRAFFIC: "Traffic", OUTCOME_LEADS: "Leads",
    OUTCOME_ENGAGEMENT: "Engagement", OUTCOME_AWARENESS: "Awareness", OUTCOME_APP_PROMOTION: "App Promotion",
  }[objective] || objective;
}

const BUDGET_BASIS_EXPLANATION = {
  USER_PROVIDED: "as you specified",
  SAVED_POLICY: "based on your saved budget policy",
  HISTORICAL_PERFORMANCE: "based on your account's historical spend",
  HEURISTIC_STARTING_TEST: "as a conservative starting test budget",
};

// Step 11 — the ONLY thing the customer ever sees: no raw JSON, no
// internal ids, no schema names, no plan/strategy id.
// Live bug (round 30): this rendered a bare number ("500/day") with no
// currency at all — the backend text itself was never wrong, but with
// nothing telling the model what currency that number is actually in, it
// defaulted to "$" in its own prose on a real PKR account. Now renders the
// REAL resolved ad account's currency code (captured at build/revise time
// — see assetResolution.js/businessSnapshot.js) directly in the backend
// text itself, so there's no gap left for the model to fill with a guess.
// Falls back to the old bare-number rendering only when the currency
// genuinely isn't known yet (no ad account resolved).
function formatBudgetLine(strategy, names) {
  if (strategy.budget_daily == null) return "Not yet set — needs your input";
  const basis = BUDGET_BASIS_EXPLANATION[strategy.budget_basis] || "basis not specified";
  const amount = names.adAccountCurrency ? `${names.adAccountCurrency} ${strategy.budget_daily}/day` : `${strategy.budget_daily}/day`;
  return `${amount} (${basis})`;
}

// Live bug (round 31): the schema has ALWAYS had a goal_alignment field
// (literal_request/likely_business_outcome/recommendation_differs_from_
// literal_request) — designed exactly for "the user asked for traffic,
// the recommendation is sales instead" (checkGoalAlignmentPolicy/
// checkLiteralGoalSubstitutionPolicy above can both require it be SET —
// but nothing here ever rendered it into the text the customer actually
// reads. A policy check on a schema field only proves the model typed
// something into a property; it never guaranteed the visible
// recommendation actually explains the swap in its own prose. Rendered
// deterministically here so the acknowledgment reaches the customer
// regardless of whether the model's own reasoning_summary happens to
// restate it.
function formatGoalAlignmentNote(strategy) {
  if (!strategy.goal_alignment?.recommendation_differs_from_literal_request) return null;
  const { literal_request, likely_business_outcome } = strategy.goal_alignment;
  if (!literal_request && !likely_business_outcome) return null;
  const parts = [];
  if (literal_request) parts.push(`You asked for: ${literal_request}.`);
  parts.push(`Recommending ${objectiveLabel(strategy.recommended_objective)} instead${likely_business_outcome ? ` — ${likely_business_outcome}` : "."}`);
  return parts.join(" ");
}

function formatRecommendation(strategy, names) {
  if (strategy.mode === "explicit_action") {
    const actionLabel = {
      BOOST_FACEBOOK_POST: "boost your most recent Facebook post",
      BOOST_INSTAGRAM_POST: "boost your most recent Instagram post",
      USE_ATTACHED_IMAGE: "run the image you attached as an ad",
      USE_ATTACHED_VIDEO: "run the video you attached as an ad",
    }[strategy.action_type] || "run this as an ad";
    const budgetLine = formatBudgetLine(strategy, names);
    // Round 40 — per-user defaults (ad account/Page/Pixel/destination URL)
    // are used SILENTLY, never asked about again once learned — visibility
    // in this summary is the only thing standing between a stale/wrong
    // default and an approved campaign built on it, so all four always
    // appear here, not just when freshly resolved this turn.
    const lines = [
      `I'll ${actionLabel}.`,
      ``,
      `Ad Account: ${names.adAccountName || "(not resolved)"}`,
      `Facebook Page: ${names.pageName || "(not resolved)"}`,
      `Pixel: ${names.pixelName || "(none)"}`,
      `Destination URL: ${strategy.destination_url || "(not set)"}`,
      `Budget: ${budgetLine}`,
      `Status: Paused (won't spend until you approve)`,
      ``,
      `Why:`,
      strategy.reasoning_summary,
    ];
    if (strategy.unresolved_questions?.length) {
      lines.push(``, `Before I can build this, I need you to confirm:`);
      for (const q of strategy.unresolved_questions) lines.push(`- ${q}`);
    } else {
      lines.push(``, `Approve this to proceed.`);
    }
    return lines.join("\n");
  }

  const genderLabel = { ALL: "All genders", MALE: "Men", FEMALE: "Women" }[strategy.gender] || strategy.gender;
  const budgetLine = formatBudgetLine(strategy, names);
  const placementsLabel = strategy.placements === "ADVANTAGE_PLUS" ? "Advantage+ (automatic)" : (strategy.manual_placements || []).join(", ");
  const goalAlignmentNote = formatGoalAlignmentNote(strategy);
  const lines = [
    `Based on your store, Meta account, and available business data, I recommend:`,
    ``,
    `Goal: ${objectiveLabel(strategy.recommended_objective)}`,
  ];
  if (goalAlignmentNote) lines.push(goalAlignmentNote);
  lines.push(
    `Audience: ${genderLabel} ${strategy.age_min}–${strategy.age_max}`,
    `Location: ${strategy.locations.join(", ")}`,
    `Strategy: ${strategy.targeting_approach.replace(/_/g, " ").toLowerCase()}`,
    `Placements: ${placementsLabel}`,
    `Optimization: ${strategy.optimization_event.replace(/_/g, " ").toLowerCase()}`,
    `Creative: ${strategy.creative_strategy.description}`,
    `Budget: ${budgetLine}`,
    // Round 40 — per-user defaults are used SILENTLY and never re-asked
    // about — this summary is the only place a stale/wrong default
    // becomes visible before approval, so Ad Account/Pixel/Destination URL
    // always appear here, not just when freshly resolved this turn.
    `Ad Account: ${names.adAccountName || "(not resolved)"}`,
    `Facebook Page: ${names.pageName || "(not resolved)"}`,
    `Pixel: ${names.pixelName || "(none)"}`,
    `Destination URL: ${strategy.destination_url || "(not set)"}`,
  );
  if (names.instagramUsername) lines.push(`Instagram: @${names.instagramUsername}`);
  lines.push(`Status: Paused (won't spend until you approve)`);
  lines.push(``, `Why:`, strategy.reasoning_summary);
  if (strategy.assumptions?.length) {
    lines.push(``, `Assumptions made:`);
    for (const a of strategy.assumptions) lines.push(`- ${a}`);
  }
  if (strategy.unresolved_questions?.length) {
    lines.push(``, `Before I can build this, I need you to confirm:`);
    for (const q of strategy.unresolved_questions) lines.push(`- ${q}`);
  } else {
    lines.push(``, `Approve this strategy or tell me what you'd like changed.`);
  }
  return lines.join("\n");
}

async function runBuildOrRevise({ userId, conversationId, accessToken, requestedChanges, userMessage, explicitAssetChangesInput, revisionOf, priorStored, freshResearchRequired }) {
  const explicitAssetChanges = new Set(Array.isArray(explicitAssetChangesInput) ? explicitAssetChangesInput.filter((f) => ASSET_FIELDS.includes(f)) : []);
  // Diagnostic (round 31 live bug: a revise_strategy call answering an
  // open Pixel-ambiguity question kept re-hitting the SAME question in a
  // loop) — the raw call parameters, before any merge/normalization, so a
  // future incident is diagnosable directly from this line rather than
  // inferred from the final stored row.
  if (traceEnabled && revisionOf) {
    trace("revise_strategy request", { conversationId, revisionOf, requestedChangesPixelRef: requestedChanges?.pixel?.ref ?? null, explicitAssetChangesInput: explicitAssetChangesInput || [] });
  }

  let merged = priorStored ? mergeForRevision(priorStored, requestedChanges, explicitAssetChanges) : requestedChanges;

  // Budget provenance verification (Step 4) — BEFORE anything downstream
  // trusts an USER_PROVIDED claim. Checked against the RAW requestedChanges
  // (this call's own assertion), not the merged object, so a revision that
  // silently carries forward an ALREADY-verified USER_PROVIDED budget
  // (this turn didn't even mention budget) isn't re-flagged.
  merged = verifyUserProvidedBudget(requestedChanges, merged, userMessage);

  const { strategy: aliasNormalized, appliedAliases } = normalizeStrategyEnumAliases(merged);
  const ctaResolved = deriveCtaIfMissing(aliasNormalized);
  const approvalResolved = deriveApprovalRequiredIfMissing(ctaResolved);
  // For a revision, mergeForRevision() above already carries facebook_page/
  // ad_account forward from the prior strategy unless explicitAssetChanges
  // says otherwise, so this only ever actually fires on a fresh build_strategy
  // call where the model itself omitted the field.
  const assetRefsResolved = deriveDefaultAssetRefsIfMissing(approvalResolved);
  // Live bug (round 18): the model kept omitting budget_daily from its
  // build_strategy/revise_strategy call even on the turn RIGHT AFTER the
  // user had just typed a number ("500/day") in direct response to being
  // asked for one — re-asking the same question the user had already
  // answered, in a loop. Safe to fill in ONLY because the number comes
  // straight from the user's own current message (see
  // deriveBudgetFromUserMessageIfMissing's comment) — never invented.
  const budgetFromMessageResolved = deriveBudgetFromUserMessageIfMissing(assetRefsResolved, userMessage);
  // Live bug (round 22): "Missing required field 'countries'" hard-
  // rejected an otherwise-complete strategy — locations (e.g. "Pakistan")
  // was present, countries (the real ISO codes) was not. Only fires when
  // every location name maps unambiguously to a known country.
  const countriesResolved = deriveCountriesFromLocationsIfMissing(budgetFromMessageResolved);
  // Live bug (user-reported follow-up): the derivation above only helps
  // when the model supplied `locations` but omitted `countries` — it does
  // nothing when the model supplies NEITHER, which is what a live report
  // hit ("use one of my facebook page posts as the ad," no location
  // wording at all, 3 identical rejections). Falls back to the store's
  // own real, already-connected country (getStoreCountryForFallback,
  // businessSnapshot.js) — never invented, and never overrides a value
  // the model (or the user) actually supplied: only fires when BOTH
  // locations and countries are absent. If the store's country is
  // missing or ambiguous, getStoreCountryForFallback returns null and
  // this falls straight through to the existing "Missing required field"
  // rejection — advertising in the wrong country is worse than asking.
  const needsStoreCountryFallback = (!Array.isArray(countriesResolved.locations) || !countriesResolved.locations.length)
    && (!Array.isArray(countriesResolved.countries) || !countriesResolved.countries.length);
  const fallbackStoreCountry = needsStoreCountryFallback ? await getStoreCountryForFallback(userId) : null;
  const storeCountryResolved = fallbackStoreCountry
    ? { ...countriesResolved, locations: [fallbackStoreCountry], countries: [fallbackStoreCountry] }
    : countriesResolved;
  if (traceEnabled && fallbackStoreCountry) {
    trace("strategy locations/countries derived from store's own connected country (missing from model output entirely)", { conversationId, derivedCountry: fallbackStoreCountry });
  }
  // Live bug (round 24): "Missing required field 'reasoning_summary'" hard-
  // rejected a strategy right after the model recovered from a wrong-tool
  // attempt (execute_strategy with no active strategy -> falling back to
  // build_strategy), where it appears to deprioritize a field it may have
  // already reasoned through moments earlier. reasoning_summary is a
  // templated restatement of already-decided facts (see
  // repairSalesReasoningSummary below), not a unique judgment call, so a
  // missing summary is just the most extreme case of "wrong" — fixable the
  // same mechanical way, before structural validation ever sees it.
  const reasoningSummaryResolved = deriveReasoningSummaryIfMissing(storeCountryResolved);
  // Live bug (round 26): "Missing required field 'evidence_used'" hard-
  // rejected a strategy the same way — evidence_used (and the identically-
  // shaped assumptions) is explicitly allowed to be an empty array by its
  // own validation rule below, so an omitted value and an explicit []
  // mean the same thing structurally. Never invents evidence — only fills
  // in when the field is truly absent.
  const emptyArrayFieldsResolved = deriveEmptyArrayFieldsIfMissing(reasoningSummaryResolved);
  let normalized = capHeuristicBudget(emptyArrayFieldsResolved);
  // "campaign" is the default mode everywhere downstream — set it
  // explicitly on the object itself (not just as a local default inside
  // validateStrategyStructure) so every later `strategy.mode === "campaign"`
  // check (the ambiguous-Pixel unresolved_questions injection below,
  // content-selector resolution, etc.) behaves consistently regardless of
  // whether the caller bothered to set it.
  if (!normalized.mode) normalized = { ...normalized, mode: "campaign" };
  if (traceEnabled && appliedAliases.length) trace("strategy enum normalization", { conversationId, appliedAliases });
  if (traceEnabled && typeof aliasNormalized.approval_required !== "boolean") {
    trace("strategy approval_required defaulted (missing from model output)", { conversationId, defaultedTo: true });
  }
  if (traceEnabled && (assetRefsResolved.facebook_page !== approvalResolved.facebook_page || assetRefsResolved.ad_account !== approvalResolved.ad_account)) {
    trace("strategy asset ref(s) defaulted (missing from model output)", {
      conversationId,
      facebookPageDefaulted: assetRefsResolved.facebook_page !== approvalResolved.facebook_page,
      adAccountDefaulted: assetRefsResolved.ad_account !== approvalResolved.ad_account,
    });
  }
  if (traceEnabled && budgetFromMessageResolved.budget_daily !== assetRefsResolved.budget_daily) {
    trace("strategy budget derived from user message (missing from model output)", { conversationId, derivedBudget: budgetFromMessageResolved.budget_daily });
  }
  if (traceEnabled && countriesResolved.countries !== budgetFromMessageResolved.countries) {
    trace("strategy countries derived from locations (missing from model output)", { conversationId, derivedCountries: countriesResolved.countries });
  }
  if (traceEnabled && reasoningSummaryResolved.reasoning_summary !== storeCountryResolved.reasoning_summary) {
    trace("strategy reasoning_summary defaulted (missing from model output)", { conversationId, derivedReasoningSummary: reasoningSummaryResolved.reasoning_summary });
  }
  if (traceEnabled && (emptyArrayFieldsResolved.evidence_used !== reasoningSummaryResolved.evidence_used || emptyArrayFieldsResolved.assumptions !== reasoningSummaryResolved.assumptions)) {
    trace("strategy evidence_used/assumptions defaulted to [] (missing from model output)", {
      conversationId,
      evidenceUsedDefaulted: emptyArrayFieldsResolved.evidence_used !== reasoningSummaryResolved.evidence_used,
      assumptionsDefaulted: emptyArrayFieldsResolved.assumptions !== reasoningSummaryResolved.assumptions,
    });
  }
  if (traceEnabled && normalized.budget_daily !== budgetFromMessageResolved.budget_daily) {
    trace("strategy heuristic budget cap", { conversationId, original: budgetFromMessageResolved.budget_daily, capped: normalized.budget_daily, cap: MAX_SUGGESTED_DAILY_BUDGET });
  }

  const structural = validateStrategyStructure(normalized);
  if (!structural.valid) {
    // Round 25: dump the actual locations/countries values alongside the
    // error — the error string alone ("Missing required field 'countries'")
    // doesn't say WHY derivation didn't fire, which is what made this bug
    // take an extra round to root-cause. Any future occurrence is now
    // immediately diagnosable from the trace log instead of guessing.
    trace("strategy rejected (structural)", { conversationId, errors: structural.errors, locations: normalized.locations, countries: normalized.countries });
    return { ok: false, unresolved: buildUnresolvedIssue(structural.errors) };
  }

  // Step 6: research is only refreshed when genuinely needed/requested —
  // a revision that doesn't ask for fresh data reuses the snapshot the
  // PRIOR strategy was already built from (still a real, once-fetched
  // trusted snapshot, just not re-fetched again this call).
  const needsFreshSnapshot = !priorStored || freshResearchRequired === true;
  const snapshot = needsFreshSnapshot ? await gatherBusinessSnapshot(userId) : priorStored.snapshot;

  // Round 35 fix — verify a claimed destination_url against the user's
  // own current words before trusting it (same discipline as
  // verifyUserProvidedBudget above; checked against the RAW requestedChanges,
  // not the merged object, for the identical "this call's own assertion"
  // reason). Never silently ships a cached/suggested storeUrl the user
  // never actually confirmed — see the requirement block below.
  // Round 36 fix — pass the PRIOR stored value too, so a later call that
  // merely re-asserts an already-verified destination_url (never touched
  // by this turn's own message) doesn't get silently wiped back to null.
  normalized = verifyDestinationUrl(requestedChanges, normalized, userMessage, snapshot?.business?.storeUrl, priorStored?.strategy?.destination_url);

  // Round 40 — per-user default destination URL. "Confirmed this turn"
  // means THIS call's own requestedChanges actually claimed a
  // destination_url (never a value merely carried forward from a prior
  // revision via mergeForRevision's generic "any key present overrides"
  // spread, which would otherwise make an old, already-resolved value
  // look like a fresh confirmation on every later revision) AND it
  // survived verifyDestinationUrl above unchanged.
  const destinationUrlConfirmedThisTurn = typeof requestedChanges.destination_url === "string"
    && requestedChanges.destination_url.trim() && normalized.destination_url === requestedChanges.destination_url;

  // Read: applied ONLY when nothing was confirmed or carried forward this
  // call (normalized.destination_url still empty) — an explicit or
  // re-confirmed value from the user's own words this turn always wins
  // over a stored default, never the reverse (same priority order as the
  // Meta-asset resolvers: explicit > saved default). Always visible
  // afterward via the new "Destination URL" summary line below, so a
  // wrong stored default surfaces before approval rather than silently
  // producing a broken campaign — there's no live "does this still exist"
  // check possible for a URL the way there is for a Pixel/Page/ad account,
  // so visibility IS the safety net here.
  if (!normalized.destination_url && userId) {
    const conn = getConnection(userId, "meta_ads");
    const savedDefaultUrl = JSON.parse(conn?.meta || "{}").defaults?.destinationUrl || null;
    if (savedDefaultUrl) normalized = { ...normalized, destination_url: savedDefaultUrl };
  }

  // Write: same shared, independently-verified path as ad account/Page/
  // Pixel (assetResolution.js) — a value is only ever LEARNED as a lasting
  // default when it's independently found, literally, in THIS turn's raw
  // message (userMessageContainsUrl — the exact same literal-substring
  // check verifyDestinationUrl itself already applies for a manually-typed
  // URL), never just because verifyDestinationUrl above already accepted
  // it. That acceptance also allows an AFFIRMED SUGGESTION match ("yes,
  // use that" confirming the store's own URL) with no literal URL in the
  // message to re-check — accepted as a deliberate, narrower scope call
  // this round: that one confirmation shape doesn't teach a default, the
  // campaign itself is entirely unaffected either way.
  if (destinationUrlConfirmedThisTurn && userId && userMessageContainsUrl(userMessage, normalized.destination_url)) {
    learnConnectionDefault(userId, "meta_ads", "destinationUrl", normalized.destination_url);
  }

  const priorResolved = priorStored
    ? { adAccountId: priorStored.resolvedAssets.adAccountId, adAccountName: priorStored.resolvedAssets.adAccountName, adAccountCurrency: priorStored.resolvedAssets.adAccountCurrency, pageId: priorStored.resolvedAssets.pageId, pageName: priorStored.resolvedAssets.pageName, instagramId: priorStored.resolvedAssets.instagramId, instagramUsername: priorStored.resolvedAssets.instagramUsername, pixelId: priorStored.resolvedAssets.pixelId, catalogId: priorStored.resolvedAssets.catalogId }
    : null;
  const { resolved, names, resolutionErrors, anyPixelExists, usablePixelForSelectedAdAccount, pixelAmbiguous } =
    await resolveStrategyAssets(normalized, { userId, accessToken, priorResolved, explicitAssetChanges, snapshot, userMessage });

  // Creative selection (Phase 1 follow-up: attach a real ad, not just a
  // Campaign + Ad Set) — same resolution shape as Pixel above: explicit
  // pick wins, then the prior strategy's ALREADY-RESOLVED choice is reused
  // verbatim (contentSelectorProvidedThisCall is checked against the RAW,
  // pre-merge requestedChanges — same "explicit this turn" signal
  // explicitAssetChanges is for identity assets), then a single real
  // candidate auto-resolves, then genuine ambiguity becomes a real
  // question. See creativeResolution.js's header comment for why this
  // deliberately does NOT write back to the account-level defaults record
  // the way Pixel does — content isn't a stable identity.
  const priorCreative = priorStored?.resolvedAssets?.creative || null;
  // Round 34 fix — a pick that was never independently verified against
  // the user's own words (creativeResolution.js's pendingCreative) is
  // read from its OWN separate stored field, never from resolvedAssets.
  // creative — so it can only ever be promoted by a fresh affirmation
  // inside resolveCreativeSelection, never by this reuse-verbatim lookup.
  const priorPendingCreative = priorStored?.resolvedAssets?.pendingCreative || null;
  const contentSelectorProvidedThisCall = requestedChanges?.content_selector !== undefined;
  // Round 37 fix (live production report: explicit_action silently picked
  // a creative with no confirmation — "I'll boost your most recent
  // Facebook post" with five real candidates available, none asked
  // about). BOOST_FACEBOOK_POST/BOOST_INSTAGRAM_POST used to resolve
  // their content through resolveContentSelector below, which had no
  // ambiguity handling at all and never independently verified a
  // model-supplied content_selector against the user's own words — the
  // exact bug class round 34 already fixed for campaign mode. Rather
  // than port that logic a second time, these two action types now go
  // through the SAME resolveCreativeSelection (creativeResolution.js)
  // candidate-list/pendingCreative pipeline campaign mode uses, by
  // synthesizing the EXISTING_PAGE_POST/EXISTING_INSTAGRAM_POST
  // creative_strategy shape that function expects (never stored on the
  // real strategy — normalized.creative_strategy stays unset for
  // explicit_action everywhere else, exactly as before). USE_ATTACHED_
  // IMAGE/USE_ATTACHED_VIDEO reference a specific chat attachment, never
  // ambiguous, and keep going through resolveContentSelector unchanged.
  const explicitActionCreativeSource = normalized.mode === "explicit_action"
    ? { BOOST_FACEBOOK_POST: "EXISTING_PAGE_POST", BOOST_INSTAGRAM_POST: "EXISTING_INSTAGRAM_POST" }[normalized.action_type] || null
    : null;
  const creativeResolution = normalized.mode === "campaign"
    ? resolveCreativeSelection({ strategy: normalized, snapshot, priorCreative, priorPendingCreative, contentSelectorProvidedThisCall, userMessage })
    : explicitActionCreativeSource
      ? resolveCreativeSelection({
          strategy: { ...normalized, mode: "campaign", creative_strategy: { source: explicitActionCreativeSource, description: normalized.business_goal || "" } },
          snapshot, priorCreative, priorPendingCreative, contentSelectorProvidedThisCall, userMessage,
        })
      : { creative: null, ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false, pendingCreative: null };
  if (creativeResolution.creativeError) {
    resolutionErrors.push({ field: "creative_strategy", message: creativeResolution.creativeError, code: "META_V2_CREATIVE_NOT_FOUND" });
  }
  // Preserves resolveContentSelector's old "no recent posts found" message
  // for the zero-candidates case — resolveCreativeSelection deliberately
  // returns no error there for EXISTING_PAGE_POST/EXISTING_INSTAGRAM_POST
  // (its own comment: checkCreativeSourceAvailabilityPolicy already
  // covers that for campaign mode, with campaign-mode-specific advice —
  // "switch to PRODUCT_IMAGE" — that makes no sense for a boost action,
  // so it's deliberately NOT reused here).
  if (explicitActionCreativeSource && !creativeResolution.creative && !creativeResolution.ambiguousCandidates.length
    && !creativeResolution.pendingCreative && !creativeResolution.creativeError) {
    const isInstagram = explicitActionCreativeSource === "EXISTING_INSTAGRAM_POST";
    resolutionErrors.push({
      field: "content_selector",
      message: `No recent ${isInstagram ? "Instagram" : "Facebook"} posts were found to boost — check the connected ${isInstagram ? "Instagram account" : "Facebook Page"}.`,
      code: "META_V2_CONTENT_NOT_FOUND",
    });
  }
  if (traceEnabled) {
    trace("creative resolution", {
      conversationId, source: normalized.creative_strategy?.source, resolved: Boolean(creativeResolution.creative),
      ambiguousCount: creativeResolution.ambiguousCandidates.length, needsPrimaryTextQuestion: creativeResolution.needsPrimaryTextQuestion,
      unsupportedSource: creativeResolution.unsupportedSource, reusedFromPrior: !contentSelectorProvidedThisCall && Boolean(priorCreative),
      pending: Boolean(creativeResolution.pendingCreative), pendingAffirmed: Boolean(priorPendingCreative) && Boolean(creativeResolution.creative) && !contentSelectorProvidedThisCall,
    });
  }

  // Live bug (round 31): a revision's requestedChanges only ever names the
  // fields actually changing (e.g. just budget_daily, from the round-30
  // auto-revise triggered by the user supplying a budget in chat) —
  // mergeForRevision above carries every OTHER field forward from the
  // prior row via the generic "any key present in requestedChanges
  // overrides" merge, and unresolved_questions is one of those (not an
  // ASSET_FIELD). A MECHANICALLY-injected question from a PRIOR row (the
  // budget-missing ask below, or the ambiguous-Pixel ask further below)
  // therefore survives verbatim into a revision that actually answers
  // it — the underlying condition is now false, but the stale question
  // text is still sitting in unresolved_questions, which the round-31
  // execution-time gate (checkV2ExecutionApprovalGate/executeStrategy)
  // correctly refuses to execute past, blocking a strategy that's
  // genuinely ready. Prune BOTH known mechanical questions the moment
  // their trigger condition is no longer true, right before the two
  // injection blocks below (so a condition that's STILL true simply gets
  // re-added by them, deduplicated via the same Set pattern they already
  // use) — never touches a genuine, model-authored business question,
  // which is never exactly one of these two fixed strings.
  // Creative candidate/primaryText questions are DYNAMIC strings (the real
  // candidate list, or the real product name, embedded in the text) — the
  // exact-string match above can't recognize them, so they're pruned by a
  // stable prefix instead (see creativeResolution.js's formatters — both
  // always start with these exact phrases regardless of which real
  // candidates/product they name).
  const isCreativeCandidatesQuestion = (q) => q.startsWith("Which ") && q.includes("should I use as the ad's creative?");
  // Round 34 fix — pendingCreative's confirmation question, same stable-
  // prefix pruning discipline as the two above (see
  // formatCreativeConfirmationQuestion, creativeResolution.js).
  const isCreativeConfirmationQuestion = (q) => q.startsWith("To confirm — you'd like to use");
  const isPrimaryTextQuestion = (q) => q.startsWith('What ad text would you like for the "');
  // Round 35 fix (live bug — Meta error 100/3858720: "Your campaign
  // objective requires an external website URL"). An existing Facebook/
  // Instagram post carries no link of its own; a website-conversion
  // objective needs one on the ad creative regardless. Computed here (not
  // just at the injection block below) so the SAME condition can prune
  // this question the moment it's no longer true, exactly like the Pixel-
  // ambiguity/creative-candidates questions above.
  const isDestinationUrlQuestion = (q) => q.startsWith("This campaign needs a destination website URL");
  const needsDestinationUrl = normalized.mode === "campaign"
    && PURCHASE_LIKE_EVENTS.has(normalized.optimization_event)
    && normalized.conversion_location === "WEBSITE"
    && ["EXISTING_PAGE_POST", "EXISTING_INSTAGRAM_POST"].includes(normalized.creative_strategy?.source)
    && !normalized.destination_url;
  if (normalized.unresolved_questions?.length) {
    normalized = {
      ...normalized,
      unresolved_questions: normalized.unresolved_questions.filter((q) => {
        if (q === "What daily budget would you like for this?") return normalized.budget_daily == null;
        if (q === "This ad account has multiple Meta Pixels connected and none is set as the default — which one should track purchases for this campaign?") return !resolved.pixelId;
        if (isCreativeCandidatesQuestion(q)) return creativeResolution.ambiguousCandidates.length > 0;
        if (isCreativeConfirmationQuestion(q)) return Boolean(creativeResolution.pendingCreative);
        if (isPrimaryTextQuestion(q)) return creativeResolution.needsPrimaryTextQuestion;
        if (isDestinationUrlQuestion(q)) return needsDestinationUrl;
        return true;
      }),
    };
  }

  // Requirement (round-14-equivalent, built in from the start this time):
  // a genuinely AMBIGUOUS Pixel (2+ available, no default, no explicit
  // choice) becomes a real unresolved_questions ask, never a hard
  // rejection and never a silent objective downgrade.
  if (normalized.mode === "campaign" && PURCHASE_LIKE_EVENTS.has(normalized.optimization_event) && !resolved.pixelId && pixelAmbiguous) {
    const question = "This ad account has multiple Meta Pixels connected and none is set as the default — which one should track purchases for this campaign?";
    normalized = { ...normalized, unresolved_questions: [...new Set([...(normalized.unresolved_questions || []), question])], approval_required: true };
  }

  // Same principle, for creative: 2+ real candidates for the strategy's
  // chosen creative_strategy.source, no explicit pick — a real question
  // naming the real candidates (ids, captions/product names, real
  // engagement or an honest "no engagement data available"), never a
  // silent "use the first one."
  // explicitActionCreativeSource stands in for normalized.creative_strategy?.
  // source below wherever the question text needs to say "Facebook post"/
  // "Instagram post" rather than a generic "item" — normalized.creative_strategy
  // itself stays genuinely unset for explicit_action (see above).
  const creativeQuestionSource = normalized.mode === "campaign" ? normalized.creative_strategy?.source : explicitActionCreativeSource;
  if (creativeResolution.ambiguousCandidates.length > 0) {
    const question = formatCreativeCandidatesQuestion(creativeQuestionSource, creativeResolution.ambiguousCandidates);
    normalized = { ...normalized, unresolved_questions: [...new Set([...(normalized.unresolved_questions || []), question])], approval_required: true };
  }

  // Round 34 fix — a pick that couldn't be independently verified against
  // the user's own words (creativeResolution.js's pendingCreative) is
  // never silently trusted as `creative`; it must be confirmed back to
  // the user first, concretely enough (real caption excerpt + real post
  // date) that a wrong guess is obvious at a glance. Same
  // unresolved_questions/approval_required mechanism as every other open
  // business question — execute_strategy stays blocked, and the
  // orchestrator's final-reply gate (orchestrator/index.js) requires this
  // question to actually reach the customer, not just get generated here.
  if (creativeResolution.pendingCreative) {
    // .source here is always the real (possibly synthetic, for
    // explicit_action) source resolveCreativeSelection itself resolved
    // against — already correct without needing creativeQuestionSource.
    const question = formatCreativeConfirmationQuestion(creativeResolution.pendingCreative.source, creativeResolution.pendingCreative.candidate);
    normalized = { ...normalized, unresolved_questions: [...new Set([...(normalized.unresolved_questions || []), question])], approval_required: true };
  }

  // A resolved PRODUCT_IMAGE candidate with no real shortDescription and
  // no verified user-supplied answer — never let the model invent ad
  // copy (explicitly out of scope). Asked exactly once, in plain
  // language, the same way budget_daily is asked for above.
  if (creativeResolution.needsPrimaryTextQuestion) {
    const question = formatPrimaryTextQuestion(creativeResolution.resolvedProductForQuestion);
    normalized = { ...normalized, unresolved_questions: [...new Set([...(normalized.unresolved_questions || []), question])], approval_required: true };
  }

  // Live bug (round 29): a strategy could be built/revised and PRESENTED
  // to the user with budget_daily left unset — checkBudgetPolicy
  // (policy.js) deliberately never rejects this (money is a genuine user
  // decision, never invented, same principle as this block's Pixel case
  // above), and formatRecommendation already renders "Budget: Not yet
  // set — needs your input" in the text, but without a matching
  // unresolved_questions entry the SAME recommendation also closed with
  // "Approve this strategy...", inviting the user to approve something
  // that structurally cannot execute. The gap was only ever caught later,
  // at execute_strategy time, by checkV2ExecutionApprovalGate (orchestrator/
  // index.js) — by then the user has already said "approve," and no
  // amount of repeating that word can supply a budget that was never
  // asked for. Ask for it up front, exactly once, as a real question —
  // deriveBudgetFromUserMessageIfMissing above already tried extracting
  // it from the user's own current message, so reaching this point means
  // it's genuinely not there yet. Applies to both modes (a boost/explicit
  // action needs a real budget just as much as a full campaign).
  if (normalized.budget_daily == null) {
    const question = "What daily budget would you like for this?";
    normalized = { ...normalized, unresolved_questions: [...new Set([...(normalized.unresolved_questions || []), question])], approval_required: true };
  }

  // Round 35 fix — see needsDestinationUrl above. snapshot.business.storeUrl
  // (businessSnapshot.js, from the connected WooCommerce/Shopify store) is
  // offered ONLY as a suggested candidate, never assumed — the user's own
  // words must confirm it (verifyDestinationUrl above), same discipline as
  // every other confirmable value in this pipeline. Deliberately no
  // fallback to a hardcoded/cached domain: the store's own domain has
  // changed before, so a stale value must never reach a real ad without
  // being named back to the user first.
  if (needsDestinationUrl) {
    const suggestedUrl = snapshot?.business?.storeUrl;
    const question = suggestedUrl
      ? `This campaign needs a destination website URL for the ad (it'll show on the "${normalized.cta === "SHOP_NOW" ? "Shop Now" : "call-to-action"}" button) — your connected store's URL is ${suggestedUrl}. Should I use that, or a different one?`
      : `This campaign needs a destination website URL for the ad's call-to-action button — what URL would you like it to link to?`;
    normalized = { ...normalized, unresolved_questions: [...new Set([...(normalized.unresolved_questions || []), question])], approval_required: true };
  }

  // Round 37 fix — explicit_action's BOOST_FACEBOOK_POST/BOOST_INSTAGRAM_POST
  // structurally cannot send a call_to_action/destination link at all
  // today: meta.boost_post's object_story_id/object_story_spec creative
  // (tools/meta/campaigns.js) has no such parameter, unlike attachCampaignCreative
  // (executor.js, campaign mode). A sales/purchase-style objective on a
  // boosted post would reach Meta and fail exactly the way live incident
  // (round 37) did for campaign mode — Meta error 100/3858720, "Your
  // campaign objective requires an external website URL." Refused here
  // instead, as a genuine structural rejection (never a soft
  // unresolved_questions ask — there's no answer that makes this work
  // today; a real fix is tracked separately under the dispatch-
  // unification project, #3). Checked against BOTH optimization_event and
  // recommended_objective since explicit_action requires neither, so the
  // model may have set only one. PURCHASE_LIKE_EVENTS itself isn't
  // reimported here (policy.js already imports FROM strategySchema.js —
  // importing back would cycle); the two-value list is small and stable
  // enough to duplicate directly rather than restructure the module graph
  // for it.
  const explicitActionNeedsUnsupportedCta = normalized.mode === "explicit_action"
    && ["BOOST_FACEBOOK_POST", "BOOST_INSTAGRAM_POST"].includes(normalized.action_type)
    && (["PURCHASE", "ADD_TO_CART"].includes(normalized.optimization_event) || normalized.recommended_objective === "OUTCOME_SALES");
  if (explicitActionNeedsUnsupportedCta) {
    resolutionErrors.push({
      field: "action_type",
      message: `Boosting an existing post can't be set up for a Sales/Purchase objective yet — Meta requires a destination URL and call-to-action button for that objective, and this app can't attach one to a boosted post today. Build a full campaign strategy instead (mode: "campaign", creative_strategy.source EXISTING_PAGE_POST or EXISTING_INSTAGRAM_POST) — that path fully supports it — or keep this as a Traffic/Engagement boost if a simple boosted post is genuinely what's wanted.`,
      code: "META_V2_EXPLICIT_ACTION_CTA_UNSUPPORTED",
    });
  }

  // Round 39 fix — companion to explicitActionNeedsUnsupportedCta above,
  // same "genuine structural rejection, never a soft unresolved_questions
  // ask" discipline, but the opposite direction: USE_ATTACHED_IMAGE/
  // USE_ATTACHED_VIDEO create a REAL new ad via meta.create_image_ad/
  // meta.create_video_ad (campaigns.js), whose own creative payload
  // structurally REQUIRES a real link — unlike BOOST_FACEBOOK_POST/
  // BOOST_INSTAGRAM_POST's object_story_id creative, which has no link
  // field at all. Executor previously sent link: "" unconditionally for
  // this case (live gap — Meta error 100/1815520, "the link in this ad is
  // either missing or invalid for Link Click Ads optimization"), since
  // explicit_action mode never collects a destination_url anywhere.
  // Deliberately does NOT add a destination_url question/pre-loop here
  // (that machinery is campaign-mode-only and already deployed/working) —
  // destination_url is a general, mode-agnostic schema field the model
  // can already set on any build_strategy call, so this only READS it: if
  // the model already supplied a real one this turn, honor it (executor.js
  // now uses strategy.destination_url as the real link instead of "");
  // otherwise refuse before ever reaching Meta, same as the CTA-unsupported
  // case above.
  const explicitActionAttachedMediaNeedsLink = normalized.mode === "explicit_action"
    && ["USE_ATTACHED_IMAGE", "USE_ATTACHED_VIDEO"].includes(normalized.action_type)
    && !normalized.destination_url;
  if (explicitActionAttachedMediaNeedsLink) {
    resolutionErrors.push({
      field: "destination_url",
      message: `Using an attached ${normalized.action_type === "USE_ATTACHED_VIDEO" ? "video" : "image"} as an ad requires a real destination URL for the ad's link — none was given. Ask the user what URL this ad should link to, then set destination_url from their own words and rebuild.`,
      code: "META_V2_EXPLICIT_ACTION_LINK_REQUIRED",
    });
  }

  // Round 37 fix — for BOOST_FACEBOOK_POST/BOOST_INSTAGRAM_POST, contentId
  // now comes from creativeResolution above (the unified pipeline) rather
  // than resolveContentSelector's own (now-removed) list logic; see that
  // function's own comment. resolveContentSelector still owns the one
  // case that's genuinely never ambiguous: a specific file the user
  // attached in chat (USE_ATTACHED_IMAGE/USE_ATTACHED_VIDEO).
  let { contentId, contentError } = resolveContentSelector(normalized, snapshot);
  if (explicitActionCreativeSource && creativeResolution.creative) {
    contentId = creativeResolution.creative.contentId;
  }
  if (contentError) resolutionErrors.push({ field: "content_selector", message: contentError, code: "META_V2_CONTENT_NOT_FOUND" });

  const contextual = validateStrategyAgainstContext(normalized, {
    resolvedAdAccountId: resolved.adAccountId, resolvedPageId: resolved.pageId, resolvedPixelId: resolved.pixelId,
    resolvedInstagramId: resolved.instagramId, resolvedCatalogId: resolved.catalogId, pixelAmbiguous,
  });

  const hasStoreData = snapshot.business.commerceConnected && snapshot.business.commerceDataStatus === "exists";
  const hasCampaignHistory = (snapshot.metaHistory.campaignCount || 0) > 0;
  const businessSignals = {
    clearEcommerceWithPurchaseTracking: hasStoreData && anyPixelExists,
    hasStrongerAudienceEvidence: hasStoreData || hasCampaignHistory,
  };

  const audienceReasoningResolved = deriveAudienceReasoningIfMissing(normalized, businessSignals, snapshot);
  if (traceEnabled && audienceReasoningResolved.audience_reasoning !== normalized.audience_reasoning) {
    trace("strategy audience_reasoning defaulted (no stronger evidence exists)", { conversationId });
  }
  normalized = audienceReasoningResolved;

  // Live bug fix (creative-selection follow-up): when the user literally
  // asked for a platform whose content genuinely isn't usable right now,
  // mechanically acknowledge that in creative_strategy.description instead
  // of silently falling back to PRODUCT_IMAGE with no mention of what was
  // asked (see repairCreativeDescriptionForUnavailableLiteralSource in
  // policy.js). Applied unconditionally — it only edits description text,
  // never a real business decision, so unlike the two reasoning_summary
  // repairs below it doesn't need to be gated behind baseChecksClean.
  normalized = repairCreativeDescriptionForUnavailableLiteralSource(normalized, userMessage, snapshot);

  const goalErrors = [...checkGoalAlignmentPolicy(normalized, businessSignals), ...checkLiteralGoalSubstitutionPolicy(normalized, userMessage), ...checkExplicitActionModeMisroutePolicy(normalized, userMessage)];
  let salesConsistencyErrors = checkSalesConsistencyPolicy(normalized);
  let creativeGroundingErrors = checkCreativeGroundingPolicy(normalized, snapshot);
  // NOT eligible for the text-only auto-repair below — which specific
  // product to recommend instead is a real business decision, not a
  // wording fix (see checkCreativeSourceAvailabilityPolicy in policy.js).
  // Also includes checkLiteralCreativeSourceSubstitutionPolicy — the user
  // literally asked for a platform whose content IS usable but the model
  // picked something else anyway; same "genuine business decision, not a
  // mechanical patch" reasoning applies.
  const creativeSourceErrors = [
    ...checkCreativeSourceAvailabilityPolicy(normalized, snapshot),
    ...checkLiteralCreativeSourceSubstitutionPolicy(normalized, userMessage, snapshot),
  ];
  const audienceErrors = checkAudienceQualityPolicy(normalized, businessSignals);
  const budgetErrors = checkBudgetPolicy(normalized);
  const revisionErrors = priorStored ? checkRevisionSubstantive({ priorStrategy: priorStored.strategy, newStrategy: normalized, requestedChanges }) : [];

  // Non-strategic presentation repairs (live bugs): when the ONLY thing
  // wrong is reasoning_summary's WORDING — every real business decision
  // (objective, audience, budget, assets, placements) already checked out
  // — deterministically regenerate it instead of rejecting a sound
  // strategy over prose. See repairSalesReasoningSummary/
  // repairCreativeReasoningForMissingEvidence in policy.js. Never a
  // second build_strategy call, never another LLM generation — this stays
  // inside the model's one attempt. The two repairs are mutually
  // exclusive here (each only fires when the OTHER isn't also failing) —
  // repairSalesReasoningSummary's text never claims content performance,
  // and repairCreativeReasoningForMissingEvidence's text never mentions
  // purchases/CPA/ROAS, so chaining them would let one repair's text
  // silently undo the other's fix. The rare case where a strategy fails
  // BOTH simultaneously is returned as a real (double) rejection instead —
  // that reasoning_summary needs actual attention, not a mechanical patch.
  const baseChecksClean = !resolutionErrors.length && !contextual.errors.length &&
    !goalErrors.length && !audienceErrors.length && !budgetErrors.length && !revisionErrors.length && !creativeSourceErrors.length;
  if (baseChecksClean && salesConsistencyErrors.length && !creativeGroundingErrors.length) {
    if (traceEnabled) trace("strategy reasoning_summary auto-repaired (sales consistency)", { conversationId, before: normalized.reasoning_summary });
    normalized = { ...normalized, reasoning_summary: repairSalesReasoningSummary(normalized) };
    salesConsistencyErrors = checkSalesConsistencyPolicy(normalized);
  } else if (baseChecksClean && creativeGroundingErrors.length && !salesConsistencyErrors.length) {
    if (traceEnabled) trace("strategy reasoning_summary auto-repaired (creative grounding)", { conversationId, before: normalized.reasoning_summary });
    normalized = { ...normalized, reasoning_summary: repairCreativeReasoningForMissingEvidence(normalized) };
    creativeGroundingErrors = checkCreativeGroundingPolicy(normalized, snapshot);
  }

  const errors = [...resolutionErrors, ...contextual.errors, ...goalErrors, ...salesConsistencyErrors, ...creativeGroundingErrors, ...creativeSourceErrors, ...audienceErrors, ...budgetErrors, ...revisionErrors];

  trace("strategy final decision", {
    conversationId, accepted: errors.length === 0,
    resolvedAdAccountId: resolved.adAccountId, resolvedPageId: resolved.pageId,
    anyPixelExists, usablePixelForSelectedAdAccount, resolvedPixelId: resolved.pixelId, pixelAmbiguous,
    recommended_objective: normalized.recommended_objective, optimization_event: normalized.optimization_event,
    budget_daily: normalized.budget_daily, budget_basis: normalized.budget_basis,
    unresolvedQuestions: normalized.unresolved_questions || [],
    errorCount: errors.length,
  });

  if (errors.length) {
    trace("strategy rejected (policy/resolution)", { conversationId, errors });
    return { ok: false, unresolved: buildUnresolvedIssue(errors) };
  }

  // Persisted the SAME way resolved.pixelCandidates already is
  // (assetResolution.js) — real, Meta/WooCommerce/Shopify-confirmed
  // candidate ids only, never guessed — so the orchestrator's creative
  // auto-revise pre-loop (index.js, mirroring the pixel auto-revise) can
  // match the user's plain-chat answer against them without re-resolving
  // from scratch or trusting the model to call revise_strategy on its own.
  // Each entry also carries `label` — the SAME display text
  // formatCreativeCandidatesQuestion already showed the user (the product
  // name for PRODUCT_IMAGE, the post's caption excerpt otherwise) — so the
  // auto-revise matcher can recognize "the product name as displayed", not
  // just the id, exactly as the question invited ("reply with the number,
  // or describe which one").
  const creativeCandidateRefs = creativeResolution.ambiguousCandidates.length
    ? toCreativeCandidateRefs(creativeQuestionSource, creativeResolution.ambiguousCandidates)
    : null;
  // pendingCreative (round 34) is stored separately from `creative` and
  // from `creativeCandidates` — it's a single unverified pick awaiting an
  // explicit affirmation, not a list the auto-revise pre-loop should match
  // plain-chat text against (that pre-loop only runs while resolvedAssets.
  // creative is null AND creativeCandidates is populated; leaving
  // creativeCandidates null while pending means the ONLY way to settle it
  // is the dedicated affirmation check inside resolveCreativeSelection —
  // never a re-guess).
  const resolvedForStorage = { ...resolved, contentId, creative: creativeResolution.creative, creativeCandidates: creativeCandidateRefs, pendingCreative: creativeResolution.pendingCreative };
  const recommendationText = formatRecommendation(normalized, names);
  const stored = insertStrategy({
    userId, conversationId, mode: normalized.mode || "campaign", strategy: normalized,
    resolved: resolvedForStorage, names, snapshotVersion: snapshot.version, snapshot, recommendationText, revisionOf,
  });

  // Success — including a strategy with real unresolved_questions (a
  // genuine business decision left open, e.g. an ambiguous Pixel or a
  // pending goal-confirmation tradeoff). Those are already embedded in
  // `strategy.unresolved_questions` and rendered into recommendationText
  // itself ("Before I can build this, I need you to confirm: ..."); this
  // is NOT the same as a hard validation failure (`ok: false`) — the
  // strategy is still fully stored and presentable, just not silently
  // approved.
  return { ok: true, strategyId: stored.id, recommendationText, strategy: normalized, resolved: resolvedForStorage };
}

// Round 38 fix (the actual "rebuild blast radius" bug — round 34's and
// round 36's investigations both traced their deadlock to the SAME root:
// once the model gets stuck on an unresolved question it can't reliably
// answer via revise_strategy, it eventually calls build_strategy instead,
// which has always meant priorStored: null — a genuinely from-scratch
// strategy that silently discards every field already resolved on the
// conversation's active strategy (budget, creative, destination_url, the
// resolved Pixel — all of it, in one call). Deterministic pre-loops (see
// orchestrator/index.js) reduce how OFTEN the model needs to fall back
// like this; this fix is what makes the fallback itself harmless. An
// answered question stays answered until the user changes it — never
// "if the model behaves," which is the property those pre-loops alone
// cannot guarantee (they only ever cover ONE turn's answer to ONE
// question; nothing stopped the model from discarding all of them at
// once via the wrong tool).
//
// Only compares WHAT THE MODEL ACTUALLY SUBMITTED against what's already
// stored (diffAgainstPrior below) — never passes the model's full,
// freshly-restated object straight into the revision merge. That
// distinction matters: build_strategy's own calling convention is
// "restate the complete strategy" (unlike revise_strategy's "send ONLY
// what's changing"), so treating every restated field as an explicit
// "the user asked to reconsider this" claim would trip
// checkRevisionSubstantive (policy.js) on every field the model
// faithfully repeats unchanged — breaking build_strategy's normal
// operation, not fixing anything. Diffing first means only genuine
// changes ever reach the merge/policy pipeline; everything else is
// inherited from the prior row through the exact same mergeForRevision
// spread (and its ASSET_FIELDS/content_selector protections) a real
// revise_strategy call already goes through, untouched.
function diffAgainstPrior(fullStrategy, priorStrategy) {
  const changes = {};
  for (const [key, value] of Object.entries(fullStrategy || {})) {
    if (JSON.stringify(value) !== JSON.stringify(priorStrategy?.[key])) changes[key] = value;
  }
  return changes;
}

export async function buildStrategy({ userId, conversationId, accessToken, strategy, userMessage, explicitAssetChanges }) {
  // getMostRecentStrategyForConversation (no status filter) — the same
  // lookup the revise_strategy tool wrapper falls back to (round 37) —
  // so build_strategy and revise_strategy agree on what "the active
  // strategy for this conversation" means, regardless of which one the
  // model happens to call. Only proposed/approved/executed rows are
  // treated as live context to preserve; rejected/failed strategies have
  // nothing worth carrying forward, so a genuinely fresh build is correct
  // there (and 'superseded' can never be the MOST RECENT row for a
  // conversation by construction — something newer superseded it).
  const priorStored = conversationId ? getMostRecentStrategyForConversation(userId, conversationId) : null;
  if (priorStored && (EXECUTABLE_STATUSES.has(priorStored.status) || priorStored.status === "executed")) {
    const requestedChanges = diffAgainstPrior(strategy, priorStored.strategy);
    return runBuildOrRevise({ userId, conversationId, accessToken, requestedChanges, userMessage, explicitAssetChangesInput: explicitAssetChanges, revisionOf: priorStored.id, priorStored, freshResearchRequired: true });
  }
  return runBuildOrRevise({ userId, conversationId, accessToken, requestedChanges: strategy, userMessage, explicitAssetChangesInput: explicitAssetChanges, revisionOf: null, priorStored: null, freshResearchRequired: true });
}

export async function reviseStrategy({ userId, conversationId, accessToken, strategyId, requestedChanges, freshResearchRequired, explicitAssetChanges, userMessage }) {
  const prior = getStoredStrategy(userId, strategyId);
  if (!prior) {
    return { ok: false, unresolved: { field: "strategyId", issue: `strategyId "${strategyId}" does not match any strategy you own — it may be from a different conversation or doesn't exist.`, allIssues: [] } };
  }
  // Round 37 fix (live production report: an unrelated targeting change
  // after a campaign was already created re-opened the creative-candidate
  // question — five real posts re-listed, even though one was already
  // confirmed). Root cause: this function refused to revise an EXECUTED
  // strategy at all, so the model's only path forward was build_strategy
  // — a from-scratch build with priorStored always null, losing every
  // previously-resolved field (creative included; reusedFromPrior/
  // pendingCreative never got the chance to apply, since they only ever
  // read from priorStored). 'executed' is now accepted here too, so the
  // new revision row correctly carries the prior creative/resolvedAssets
  // forward through the SAME, unmodified mergeForRevision/creativeResolution
  // machinery every other revision already uses. This does NOT mean the
  // resulting strategy can silently re-execute against Meta — a revision
  // of an executed strategy is a NEW row (insertStrategy's supersede
  // logic never touches the executed one, which stays exactly as it was)
  // and execute_strategy on it is separately blocked by
  // checkV2ExecutionApprovalGate (orchestrator/index.js) and
  // executeStrategy's own defense-in-depth check (executor.js) — see
  // getExecutedAncestorStrategy (strategyStore.js) — specifically so it
  // can never silently create a SECOND real campaign.
  if (!EXECUTABLE_STATUSES.has(prior.status) && prior.status !== "executed") {
    return { ok: false, unresolved: { field: "strategyId", issue: `This strategy is no longer active (status: ${prior.status}) and can't be revised.`, allIssues: [] } };
  }
  return runBuildOrRevise({ userId, conversationId, accessToken, requestedChanges, userMessage, explicitAssetChangesInput: explicitAssetChanges, revisionOf: strategyId, priorStored: prior, freshResearchRequired });
}
