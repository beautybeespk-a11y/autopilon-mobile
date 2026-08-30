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
import {
  validateStrategyStructure, validateStrategyAgainstContext,
  normalizeStrategyEnumAliases, deriveCtaIfMissing, deriveApprovalRequiredIfMissing,
  deriveDefaultAssetRefsIfMissing, PURCHASE_LIKE_EVENTS,
} from "./strategySchema.js";
import {
  checkBudgetPolicy, capHeuristicBudget, verifyUserProvidedBudget,
  checkGoalAlignmentPolicy, checkSalesConsistencyPolicy, checkAudienceQualityPolicy,
  checkRevisionSubstantive, buildUnresolvedIssue, MAX_SUGGESTED_DAILY_BUDGET,
  repairSalesReasoningSummary, checkCreativeGroundingPolicy, repairCreativeReasoningForMissingEvidence,
  checkCreativeSourceAvailabilityPolicy,
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
    if (!explicitAssetChanges.has(field)) merged[field] = prior.strategy[field];
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
function formatRecommendation(strategy, names) {
  if (strategy.mode === "explicit_action") {
    const actionLabel = {
      BOOST_FACEBOOK_POST: "boost your most recent Facebook post",
      BOOST_INSTAGRAM_POST: "boost your most recent Instagram post",
      USE_ATTACHED_IMAGE: "run the image you attached as an ad",
      USE_ATTACHED_VIDEO: "run the video you attached as an ad",
    }[strategy.action_type] || "run this as an ad";
    const budgetLine = strategy.budget_daily != null
      ? `${strategy.budget_daily}/day (${BUDGET_BASIS_EXPLANATION[strategy.budget_basis] || "basis not specified"})`
      : "Not yet set — needs your input";
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
  const budgetLine = strategy.budget_daily != null
    ? `${strategy.budget_daily}/day (${BUDGET_BASIS_EXPLANATION[strategy.budget_basis] || "basis not specified"})`
    : "Not yet set — needs your input";
  const placementsLabel = strategy.placements === "ADVANTAGE_PLUS" ? "Advantage+ (automatic)" : (strategy.manual_placements || []).join(", ");
  const lines = [
    `Based on your store, Meta account, and available business data, I recommend:`,
    ``,
    `Goal: ${objectiveLabel(strategy.recommended_objective)}`,
    `Audience: ${genderLabel} ${strategy.age_min}–${strategy.age_max}`,
    `Location: ${strategy.locations.join(", ")}`,
    `Strategy: ${strategy.targeting_approach.replace(/_/g, " ").toLowerCase()}`,
    `Placements: ${placementsLabel}`,
    `Optimization: ${strategy.optimization_event.replace(/_/g, " ").toLowerCase()}`,
    `Creative: ${strategy.creative_strategy.description}`,
    `Budget: ${budgetLine}`,
    `Facebook Page: ${names.pageName || "(not resolved)"}`,
  ];
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
  let normalized = capHeuristicBudget(assetRefsResolved);
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
  if (traceEnabled && normalized.budget_daily !== ctaResolved.budget_daily) {
    trace("strategy heuristic budget cap", { conversationId, original: ctaResolved.budget_daily, capped: normalized.budget_daily, cap: MAX_SUGGESTED_DAILY_BUDGET });
  }

  const structural = validateStrategyStructure(normalized);
  if (!structural.valid) {
    trace("strategy rejected (structural)", { conversationId, errors: structural.errors });
    return { ok: false, unresolved: buildUnresolvedIssue(structural.errors) };
  }

  // Step 6: research is only refreshed when genuinely needed/requested —
  // a revision that doesn't ask for fresh data reuses the snapshot the
  // PRIOR strategy was already built from (still a real, once-fetched
  // trusted snapshot, just not re-fetched again this call).
  const needsFreshSnapshot = !priorStored || freshResearchRequired === true;
  const snapshot = needsFreshSnapshot ? await gatherBusinessSnapshot(userId) : priorStored.snapshot;

  const priorResolved = priorStored
    ? { adAccountId: priorStored.resolvedAssets.adAccountId, adAccountName: priorStored.resolvedAssets.adAccountName, pageId: priorStored.resolvedAssets.pageId, pageName: priorStored.resolvedAssets.pageName, instagramId: priorStored.resolvedAssets.instagramId, instagramUsername: priorStored.resolvedAssets.instagramUsername, pixelId: priorStored.resolvedAssets.pixelId, catalogId: priorStored.resolvedAssets.catalogId }
    : null;
  const { resolved, names, resolutionErrors, anyPixelExists, usablePixelForSelectedAdAccount, pixelAmbiguous } =
    await resolveStrategyAssets(normalized, { userId, accessToken, priorResolved, explicitAssetChanges, snapshot });

  // Requirement (round-14-equivalent, built in from the start this time):
  // a genuinely AMBIGUOUS Pixel (2+ available, no default, no explicit
  // choice) becomes a real unresolved_questions ask, never a hard
  // rejection and never a silent objective downgrade.
  if (normalized.mode === "campaign" && PURCHASE_LIKE_EVENTS.has(normalized.optimization_event) && !resolved.pixelId && pixelAmbiguous) {
    const question = "This ad account has multiple Meta Pixels connected and none is set as the default — which one should track purchases for this campaign?";
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

  const goalErrors = checkGoalAlignmentPolicy(normalized, businessSignals);
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
    errorCount: errors.length,
  });

  if (errors.length) {
    trace("strategy rejected (policy/resolution)", { conversationId, errors });
    return { ok: false, unresolved: buildUnresolvedIssue(errors) };
  }

  const resolvedForStorage = { ...resolved, contentId };
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
