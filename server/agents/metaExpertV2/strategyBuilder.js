// Meta Ads Expert V2 — the core orchestration: merge (revision only) ->
// normalize -> structural validation -> resolve assets -> quality gates ->
// store -> format recommendation. Step 7's defining rule: ONE pass, no
// automatic repair-retry loop. Deterministic normalization (enum aliases,
// CTA default, heuristic budget cap) runs before validation so a
// mechanical slip never counts as a real failure; anything that still
// fails after that is a genuine unresolved business issue, returned once
// as a single clean, customer-safe explanation — never fed back into
// another LLM attempt.
import { gatherBusinessSnapshot } from "./businessSnapshot.js";
import { resolveStrategyAssets } from "./assetResolution.js";
import { resolveCreativeSelection, formatCreativeCandidatesQuestion, formatPrimaryTextQuestion } from "./creativeResolution.js";
import {
  validateStrategyStructure, validateStrategyAgainstContext,
  normalizeStrategyEnumAliases, deriveCtaIfMissing, deriveApprovalRequiredIfMissing,
  deriveDefaultAssetRefsIfMissing, deriveAudienceReasoningIfMissing, deriveBudgetFromUserMessageIfMissing,
  deriveCountriesFromLocationsIfMissing, deriveEmptyArrayFieldsIfMissing, PURCHASE_LIKE_EVENTS,
} from "./strategySchema.js";
import {
  checkBudgetPolicy, capHeuristicBudget, verifyUserProvidedBudget,
  checkGoalAlignmentPolicy, checkLiteralGoalSubstitutionPolicy, checkSalesConsistencyPolicy, checkAudienceQualityPolicy,
  checkRevisionSubstantive, buildUnresolvedIssue, MAX_SUGGESTED_DAILY_BUDGET,
  repairSalesReasoningSummary, checkCreativeGroundingPolicy, repairCreativeReasoningForMissingEvidence,
  checkCreativeSourceAvailabilityPolicy, deriveReasoningSummaryIfMissing,
} from "./policy.js";
import { insertStrategy, getStoredStrategy, EXECUTABLE_STATUSES } from "./strategyStore.js";
import { trace, traceEnabled } from "./diagnostics.js";

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

  const isInstagram = strategy.action_type === "BOOST_INSTAGRAM_POST";
  const list = isInstagram ? snapshot?.recentContent?.instagramPosts?.items : snapshot?.recentContent?.facebookPosts?.items;
  if (!Array.isArray(list) || !list.length) {
    return { contentId: null, contentError: `No recent ${isInstagram ? "Instagram" : "Facebook"} posts were found to boost — check the connected ${isInstagram ? "Instagram account" : "Facebook Page"}.` };
  }
  if (selector.confirmedId) {
    const match = list.find((item) => item.id === selector.confirmedId);
    if (match) return { contentId: match.id, contentError: null };
    return { contentId: null, contentError: `"${selector.confirmedId}" is not one of the recent posts this conversation already saw — refer to it by position (the most recent, the second-most-recent, ...) instead of an id.` };
  }
  const position = Number.isInteger(selector.position) && selector.position > 0 ? selector.position : 1;
  const item = list[position - 1];
  if (!item) return { contentId: null, contentError: `There is no post at position ${position} — only ${list.length} recent post(s) are available.` };
  return { contentId: item.id, contentError: null };
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
    const lines = [
      `I'll ${actionLabel}.`,
      ``,
      `Facebook Page: ${names.pageName || "(not resolved)"}`,
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
    `Facebook Page: ${names.pageName || "(not resolved)"}`,
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
  // Live bug (round 24): "Missing required field 'reasoning_summary'" hard-
  // rejected a strategy right after the model recovered from a wrong-tool
  // attempt (execute_strategy with no active strategy -> falling back to
  // build_strategy), where it appears to deprioritize a field it may have
  // already reasoned through moments earlier. reasoning_summary is a
  // templated restatement of already-decided facts (see
  // repairSalesReasoningSummary below), not a unique judgment call, so a
  // missing summary is just the most extreme case of "wrong" — fixable the
  // same mechanical way, before structural validation ever sees it.
  const reasoningSummaryResolved = deriveReasoningSummaryIfMissing(countriesResolved);
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
  if (traceEnabled && reasoningSummaryResolved.reasoning_summary !== countriesResolved.reasoning_summary) {
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

  const priorResolved = priorStored
    ? { adAccountId: priorStored.resolvedAssets.adAccountId, adAccountName: priorStored.resolvedAssets.adAccountName, adAccountCurrency: priorStored.resolvedAssets.adAccountCurrency, pageId: priorStored.resolvedAssets.pageId, pageName: priorStored.resolvedAssets.pageName, instagramId: priorStored.resolvedAssets.instagramId, instagramUsername: priorStored.resolvedAssets.instagramUsername, pixelId: priorStored.resolvedAssets.pixelId, catalogId: priorStored.resolvedAssets.catalogId }
    : null;
  const { resolved, names, resolutionErrors, anyPixelExists, usablePixelForSelectedAdAccount, pixelAmbiguous } =
    await resolveStrategyAssets(normalized, { userId, accessToken, priorResolved, explicitAssetChanges, snapshot });

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
  const contentSelectorProvidedThisCall = requestedChanges?.content_selector !== undefined;
  const creativeResolution = normalized.mode === "campaign"
    ? resolveCreativeSelection({ strategy: normalized, snapshot, priorCreative, contentSelectorProvidedThisCall, userMessage })
    : { creative: null, ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false };
  if (creativeResolution.creativeError) {
    resolutionErrors.push({ field: "creative_strategy", message: creativeResolution.creativeError, code: "META_V2_CREATIVE_NOT_FOUND" });
  }
  if (traceEnabled) {
    trace("creative resolution", {
      conversationId, source: normalized.creative_strategy?.source, resolved: Boolean(creativeResolution.creative),
      ambiguousCount: creativeResolution.ambiguousCandidates.length, needsPrimaryTextQuestion: creativeResolution.needsPrimaryTextQuestion,
      unsupportedSource: creativeResolution.unsupportedSource, reusedFromPrior: !contentSelectorProvidedThisCall && Boolean(priorCreative),
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
  const isPrimaryTextQuestion = (q) => q.startsWith('What ad text would you like for the "');
  if (normalized.unresolved_questions?.length) {
    normalized = {
      ...normalized,
      unresolved_questions: normalized.unresolved_questions.filter((q) => {
        if (q === "What daily budget would you like for this?") return normalized.budget_daily == null;
        if (q === "This ad account has multiple Meta Pixels connected and none is set as the default — which one should track purchases for this campaign?") return !resolved.pixelId;
        if (isCreativeCandidatesQuestion(q)) return creativeResolution.ambiguousCandidates.length > 0;
        if (isPrimaryTextQuestion(q)) return creativeResolution.needsPrimaryTextQuestion;
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
  if (creativeResolution.ambiguousCandidates.length > 0) {
    const question = formatCreativeCandidatesQuestion(normalized.creative_strategy?.source, creativeResolution.ambiguousCandidates);
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

  let { contentId, contentError } = resolveContentSelector(normalized, snapshot);
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

  const audienceReasoningResolved = deriveAudienceReasoningIfMissing(normalized, businessSignals);
  if (traceEnabled && audienceReasoningResolved.audience_reasoning !== normalized.audience_reasoning) {
    trace("strategy audience_reasoning defaulted (no stronger evidence exists)", { conversationId });
  }
  normalized = audienceReasoningResolved;

  const goalErrors = [...checkGoalAlignmentPolicy(normalized, businessSignals), ...checkLiteralGoalSubstitutionPolicy(normalized, userMessage)];
  let salesConsistencyErrors = checkSalesConsistencyPolicy(normalized);
  let creativeGroundingErrors = checkCreativeGroundingPolicy(normalized, snapshot);
  // NOT eligible for the text-only auto-repair below — which specific
  // product to recommend instead is a real business decision, not a
  // wording fix (see checkCreativeSourceAvailabilityPolicy in policy.js).
  const creativeSourceErrors = checkCreativeSourceAvailabilityPolicy(normalized, snapshot);
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

  const resolvedForStorage = { ...resolved, contentId, creative: creativeResolution.creative };
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

export async function buildStrategy({ userId, conversationId, accessToken, strategy, userMessage, explicitAssetChanges }) {
  return runBuildOrRevise({ userId, conversationId, accessToken, requestedChanges: strategy, userMessage, explicitAssetChangesInput: explicitAssetChanges, revisionOf: null, priorStored: null, freshResearchRequired: true });
}

export async function reviseStrategy({ userId, conversationId, accessToken, strategyId, requestedChanges, freshResearchRequired, explicitAssetChanges, userMessage }) {
  const prior = getStoredStrategy(userId, strategyId);
  if (!prior) {
    return { ok: false, unresolved: { field: "strategyId", issue: `strategyId "${strategyId}" does not match any strategy you own — it may be from a different conversation or doesn't exist.`, allIssues: [] } };
  }
  if (!EXECUTABLE_STATUSES.has(prior.status)) {
    return { ok: false, unresolved: { field: "strategyId", issue: `This strategy is no longer active (status: ${prior.status}) and can't be revised.`, allIssues: [] } };
  }
  return runBuildOrRevise({ userId, conversationId, accessToken, requestedChanges, userMessage, explicitAssetChangesInput: explicitAssetChanges, revisionOf: strategyId, priorStored: prior, freshResearchRequired });
}
