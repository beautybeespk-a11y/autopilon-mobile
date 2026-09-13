// Meta Ads Expert V2 — editing an EXISTING, already-executed campaign
// (round 45). Replaces the round-37 placeholder ("editing an existing
// campaign isn't supported yet" — executor.js's META_V2_STRATEGY_REVISES_EXECUTED
// refusal, still fully in place and untouched — this feature is additive
// alongside it, not a replacement of that gate).
//
// Scope: budget and audience/targeting (gender, age_min, age_max,
// countries) — the only strategy fields that ever actually reach Meta's
// real ad set (confirmed by reading buildV2Targeting, executor.js: it
// only ever consumes countries/age_min/age_max/gender — locations,
// targeting_approach, and placements are never sent to Meta at all,
// regardless of mode). Creative is explicitly OUT of scope and refused
// outright — Meta ad creatives are effectively immutable once live; a
// creative change means a brand-new creative and a new ad, a genuinely
// different piece of work. Schedule (start_time/end_time) is also out of
// scope for v1 — nothing in this codebase has ever set those fields on an
// ad set, no precedent, no live evidence; a deliberate, smaller follow-up
// once this feature's own propose/approve/apply/verify loop has real
// Meta evidence behind it.
//
// Two-step flow, mirroring build_strategy/execute_strategy's own
// propose-then-mutate shape (never reusing revise_strategy/execute_strategy
// themselves — a campaign_edit row is structurally NOT a campaign
// strategy: no creative_strategy, no audience_strategy, no Pixel; see
// mode: "campaign_edit" below):
//   1. proposeCampaignEdit — validates the request, diffs it against the
//      executed ancestor's own stored strategy, stores a real 'proposed'
//      row (same meta_v2_strategies table, same status lifecycle,
//      distinguished by mode), returns a plain-language summary.
//   2. applyCampaignEdit — requires a SEPARATE, explicit approval this
//      turn (checkV2CampaignEditApprovalGate, orchestrator/index.js),
//      re-verifies the live campaign/ad set are still exactly what was
//      proposed against (drift check, scoped to only the fields actually
//      being changed — see targetingDrift below), applies via the new
//      updateAdSet primitive (api.js), then reads back and verifies Meta
//      actually applied it before ever calling this a success.
import * as meta from "../../integrations/meta/api.js";
import { toMetaBudgetMinorUnits, buildV2Targeting } from "./executor.js";
import { MAX_EXECUTABLE_DAILY_BUDGET, buildUnresolvedIssue, messageIndicatesExecutionApproval as messageIndicatesExecutionApprovalV2 } from "./policy.js";
import {
  insertStrategy, getStoredStrategy, getActiveStrategyForConversation, getMostRecentExecutedStrategyForConversation,
  getExecutedAncestorStrategy, EXECUTABLE_STATUSES, markStrategyApproved, setStrategyStatus, markStrategyExecuted, markStrategyFailed,
} from "./strategyStore.js";
import { assertV2RuntimeEnabled } from "./runtimeGate.js";
import { publishEvent } from "../../automation/triggers.js";
import { logger } from "../../config/logger.js";

// Only these ever reach Meta's real ad set (see buildV2Targeting,
// executor.js) — the smallest set worth supporting first, per the
// investigation this feature was built from.
const EDITABLE_FIELDS = ["budget_daily", "gender", "age_min", "age_max", "countries"];
// Explicitly refused, never silently ignored — a creative change is a
// genuinely different piece of work (new creative, new ad), not an
// ad-set-level update, and destination_url/cta are creative-adjacent
// fields with no update path here either.
const CREATIVE_REQUEST_FIELDS = new Set(["creative_strategy", "content_selector", "destination_url", "cta", "pendingCreative"]);
const GENDER_ENUM = ["ALL", "MALE", "FEMALE"];
const AGE_MIN_BOUND = 13;
const AGE_MAX_BOUND = 65;

// targetStrategyId, when given, must resolve to a real EXECUTED strategy
// (directly, or via getExecutedAncestorStrategy's revisionOf walk — the
// same "find what's actually live in Meta" lookup the round-37 duplicate-
// campaign gate already uses). With no targetStrategyId, defaults to the
// most recent campaign THIS conversation itself created — deliberately
// conversation-scoped, matching every other "omit the id" fallback in
// this codebase (getActiveStrategyForConversation, etc.); editing a
// campaign from a DIFFERENT past conversation requires naming its real
// strategy id explicitly.
function resolveTargetExecutedStrategy(userId, conversationId, targetStrategyId) {
  if (targetStrategyId) {
    const row = getStoredStrategy(userId, targetStrategyId);
    if (!row) {
      const err = new Error(`No strategy found with id "${targetStrategyId}" for this account.`);
      err.code = "META_V2_STRATEGY_REQUIRED";
      throw err;
    }
    if (row.status === "executed") return row;
    const ancestor = getExecutedAncestorStrategy(userId, row);
    if (ancestor) return ancestor;
    const err = new Error(`Strategy "${targetStrategyId}" was never executed — there's no live Meta campaign to edit.`);
    err.code = "META_V2_STRATEGY_NOT_EXECUTED";
    throw err;
  }
  const mostRecent = getMostRecentExecutedStrategyForConversation(userId, conversationId);
  if (!mostRecent) {
    const err = new Error("No executed campaign was found for this conversation to edit — build and execute a strategy first, or name the strategy id of the campaign to edit.");
    err.code = "META_V2_STRATEGY_NOT_EXECUTED";
    throw err;
  }
  return mostRecent;
}

function validateFieldValues(changes, ancestorStrategy) {
  const errors = [];
  if ("budget_daily" in changes) {
    const v = changes.budget_daily;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      errors.push({ field: "budget_daily", message: "budget_daily must be a real, positive number." });
    } else if (v > MAX_EXECUTABLE_DAILY_BUDGET) {
      errors.push({ field: "budget_daily", message: `A daily budget of ${v} exceeds the maximum executable daily budget of ${MAX_EXECUTABLE_DAILY_BUDGET} — it cannot be applied as-is.` });
    }
  }
  if ("gender" in changes && !GENDER_ENUM.includes(changes.gender)) {
    errors.push({ field: "gender", message: `gender must be one of: ${GENDER_ENUM.join(", ")}.` });
  }
  const isValidAge = (v) => Number.isInteger(v) && v >= AGE_MIN_BOUND && v <= AGE_MAX_BOUND;
  if ("age_min" in changes && !isValidAge(changes.age_min)) {
    errors.push({ field: "age_min", message: `age_min must be a whole number between ${AGE_MIN_BOUND} and ${AGE_MAX_BOUND}.` });
  }
  if ("age_max" in changes && !isValidAge(changes.age_max)) {
    errors.push({ field: "age_max", message: `age_max must be a whole number between ${AGE_MIN_BOUND} and ${AGE_MAX_BOUND}.` });
  }
  const effectiveMin = "age_min" in changes ? changes.age_min : ancestorStrategy.age_min;
  const effectiveMax = "age_max" in changes ? changes.age_max : ancestorStrategy.age_max;
  if (typeof effectiveMin === "number" && typeof effectiveMax === "number" && effectiveMin > effectiveMax
    && !errors.some((e) => e.field === "age_min" || e.field === "age_max")) {
    errors.push({ field: "age_min", message: `age_min (${effectiveMin}) cannot be greater than age_max (${effectiveMax}).` });
  }
  if ("countries" in changes) {
    const v = changes.countries;
    if (!Array.isArray(v) || !v.length || !v.every((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c))) {
      errors.push({ field: "countries", message: `countries must be a non-empty array of ISO 3166-1 alpha-2 codes (e.g. ["PK"]).` });
    }
  }
  return errors;
}

// Same JSON.stringify comparison discipline as round 38's diffAgainstPrior
// (strategyBuilder.js) — only fields that actually differ from the
// executed ancestor's own stored strategy count as a real change.
function computeGenuineChanges(changes, ancestorStrategy) {
  const genuine = {};
  for (const [key, value] of Object.entries(changes)) {
    if (JSON.stringify(value) !== JSON.stringify(ancestorStrategy[key])) genuine[key] = value;
  }
  return genuine;
}

function formatCampaignEditSummary(genuineChanges, ancestor) {
  const { campaignId, adSetId } = ancestor.executionResult;
  const lines = [`Proposed changes to your live campaign (Campaign ID: ${campaignId}, Ad Set ID: ${adSetId}):`, ``];
  if ("budget_daily" in genuineChanges) {
    lines.push(`Budget: ${ancestor.strategy.budget_daily}/day → ${genuineChanges.budget_daily}/day`);
  }
  if ("gender" in genuineChanges) {
    lines.push(`Gender: ${ancestor.strategy.gender} → ${genuineChanges.gender}`);
  }
  if ("age_min" in genuineChanges || "age_max" in genuineChanges) {
    const newMin = "age_min" in genuineChanges ? genuineChanges.age_min : ancestor.strategy.age_min;
    const newMax = "age_max" in genuineChanges ? genuineChanges.age_max : ancestor.strategy.age_max;
    lines.push(`Age: ${ancestor.strategy.age_min}–${ancestor.strategy.age_max} → ${newMin}–${newMax}`);
  }
  if ("countries" in genuineChanges) {
    lines.push(`Countries: ${(ancestor.strategy.countries || []).join(", ") || "(none)"} → ${genuineChanges.countries.join(", ")}`);
  }
  lines.push(``, `The campaign stays PAUSED — this only updates its settings for whenever you resume it.`, ``, `Reply "approve" to apply these changes, or tell me what you'd like different.`);
  return lines.join("\n");
}

export async function proposeCampaignEdit({ userId, conversationId, accessToken, targetStrategyId, requestedChanges, userMessage }) {
  assertV2RuntimeEnabled(userId);
  const ancestor = resolveTargetExecutedStrategy(userId, conversationId, targetStrategyId);

  const changes = requestedChanges && typeof requestedChanges === "object" ? requestedChanges : {};
  const keys = Object.keys(changes);
  const errors = [];

  const creativeKeys = keys.filter((k) => CREATIVE_REQUEST_FIELDS.has(k));
  if (creativeKeys.length) {
    errors.push({
      field: "requestedChanges",
      message: `Changing the ad creative on an existing campaign isn't supported — Meta ad creatives are effectively immutable once live, so a creative change means a brand-new creative and a new ad, a different piece of work. Build a separate, new campaign instead if the creative needs to change. (Unsupported field(s): ${creativeKeys.join(", ")}.)`,
    });
  }
  const unknownKeys = keys.filter((k) => !EDITABLE_FIELDS.includes(k) && !CREATIVE_REQUEST_FIELDS.has(k));
  if (unknownKeys.length) {
    errors.push({ field: "requestedChanges", message: `These fields can't be edited on an existing campaign yet: ${unknownKeys.join(", ")}. Only budget_daily, gender, age_min, age_max, and countries are supported.` });
  }
  if (!keys.length) {
    errors.push({ field: "requestedChanges", message: "No changes were specified — nothing to edit." });
  }
  errors.push(...validateFieldValues(changes, ancestor.strategy));
  if (errors.length) return { ok: false, unresolved: buildUnresolvedIssue(errors) };

  const genuineChanges = computeGenuineChanges(changes, ancestor.strategy);
  if (!Object.keys(genuineChanges).length) {
    return { ok: false, unresolved: buildUnresolvedIssue([{ field: "requestedChanges", message: "These values already match the campaign's current settings — there's nothing to change." }]) };
  }

  const recommendationText = formatCampaignEditSummary(genuineChanges, ancestor);
  const strategy = {
    mode: "campaign_edit",
    targetStrategyId: ancestor.id,
    requestedChanges: genuineChanges,
    reasoning_summary: `Requested change(s) to the live campaign (Campaign ID: ${ancestor.executionResult.campaignId}).`,
    unresolved_questions: [],
    approval_required: true,
  };
  const resolved = {
    targetCampaignId: ancestor.executionResult.campaignId,
    targetAdSetId: ancestor.executionResult.adSetId,
    targetAdAccountId: ancestor.executionResult.adAccountId || ancestor.resolvedAssets.adAccountId,
  };
  const stored = insertStrategy({ userId, conversationId, mode: "campaign_edit", strategy, resolved, names: {}, recommendationText, revisionOf: ancestor.id });
  return { ok: true, strategyId: stored.id, recommendationText };
}

// Meta's own genders array back to this app's ALL/MALE/FEMALE enum —
// needed both to detect audience drift and to preserve a live gender
// value exactly when the edit doesn't touch gender at all (merge-onto-
// live below).
function metaGendersToStrategyGender(genders) {
  if (!Array.isArray(genders) || !genders.length) return "ALL";
  const male = genders.includes(1);
  const female = genders.includes(2);
  if (male && !female) return "MALE";
  if (female && !male) return "FEMALE";
  return "ALL";
}

// Drift is checked ONLY for the fields THIS edit is actually touching —
// per explicit design decision: a human changing something on the ad set
// that this edit never asked to change (e.g. they nudged age while this
// edit only changes gender) must never block it. A blanket "anything on
// the ad set changed" refusal would make the feature unusable for anyone
// who also works in Ads Manager directly.
function targetingDrift(liveTargeting, expectedTargeting, touchedFields) {
  if (touchedFields.includes("countries")) {
    const live = [...(liveTargeting?.geo_locations?.countries || [])].sort();
    const expected = [...(expectedTargeting.geo_locations?.countries || [])].sort();
    if (JSON.stringify(live) !== JSON.stringify(expected)) return { field: "countries", liveValue: live.join(", ") || "(none)" };
  }
  if (touchedFields.includes("age_min")) {
    const live = liveTargeting?.age_min ?? null;
    if (live !== (expectedTargeting.age_min ?? null)) return { field: "age_min", liveValue: String(live) };
  }
  if (touchedFields.includes("age_max")) {
    const live = liveTargeting?.age_max ?? null;
    if (live !== (expectedTargeting.age_max ?? null)) return { field: "age_max", liveValue: String(live) };
  }
  if (touchedFields.includes("gender")) {
    const liveGender = metaGendersToStrategyGender(liveTargeting?.genders);
    const expectedGender = metaGendersToStrategyGender(expectedTargeting.genders);
    if (liveGender !== expectedGender) return { field: "gender", liveValue: liveGender };
  }
  return null;
}

function targetingEquivalent(a, b) {
  const countriesA = [...(a?.geo_locations?.countries || [])].sort();
  const countriesB = [...(b?.geo_locations?.countries || [])].sort();
  return JSON.stringify(countriesA) === JSON.stringify(countriesB)
    && (a?.age_min ?? null) === (b?.age_min ?? null)
    && (a?.age_max ?? null) === (b?.age_max ?? null)
    && metaGendersToStrategyGender(a?.genders) === metaGendersToStrategyGender(b?.genders);
}

// Builds the COMPLETE targeting spec to send — Meta's ad set update
// replaces targeting wholesale, it does not merge partial fields
// server-side. Untouched dimensions are taken from the LIVE read-back,
// never from this app's own (possibly stale) stored record — an edit
// that only asks to change gender must never silently re-assert (and
// potentially revert) a country/age value a human changed independently.
function buildMergedTargetingStrategy(requestedChanges, liveTargeting, ancestorStrategy) {
  return {
    gender: "gender" in requestedChanges ? requestedChanges.gender : metaGendersToStrategyGender(liveTargeting?.genders),
    age_min: "age_min" in requestedChanges ? requestedChanges.age_min : (liveTargeting?.age_min ?? ancestorStrategy.age_min),
    age_max: "age_max" in requestedChanges ? requestedChanges.age_max : (liveTargeting?.age_max ?? ancestorStrategy.age_max),
    countries: "countries" in requestedChanges ? requestedChanges.countries : (liveTargeting?.geo_locations?.countries?.length ? liveTargeting.geo_locations.countries : ancestorStrategy.countries),
  };
}

export async function applyCampaignEdit({ userId, conversationId, accessToken, strategyId, userMessage }) {
  assertV2RuntimeEnabled(userId);
  const stored = strategyId ? getStoredStrategy(userId, strategyId) : getActiveStrategyForConversation(userId, conversationId);
  if (!stored) {
    const err = new Error(strategyId ? `No strategy found with id "${strategyId}" for this account.` : "No pending campaign edit exists for this conversation.");
    err.code = "META_V2_STRATEGY_REQUIRED";
    throw err;
  }
  if (stored.strategy?.mode !== "campaign_edit") {
    const err = new Error("This strategy isn't a campaign edit proposal — call meta_expert_v2.execute_strategy for a new campaign, or meta_expert_v2.propose_campaign_edit first.");
    err.code = "META_V2_WRONG_APPLY_TOOL";
    throw err;
  }
  if (!EXECUTABLE_STATUSES.has(stored.status)) {
    const err = new Error(stored.status === "executed" ? "This edit has already been applied." : `This edit is no longer active (status: ${stored.status}) — propose a new edit.`);
    err.code = "META_V2_STRATEGY_REQUIRED";
    throw err;
  }
  // Defense in depth — checkV2CampaignEditApprovalGate (orchestrator/
  // index.js) already blocks this before the tool is even dispatched;
  // this function is also reachable directly. Same explicit,
  // this-turn-only approval discipline as execute_strategy's own
  // defense-in-depth check.
  if (!messageIndicatesExecutionApprovalV2(userMessage)) {
    const err = new Error("This campaign edit has not been explicitly approved in the user's latest message — ask for clear approval language (e.g. \"approve\") before applying it.");
    err.code = "META_V2_EDIT_NOT_APPROVED";
    throw err;
  }

  const ancestor = getStoredStrategy(userId, stored.strategy.targetStrategyId);
  if (!ancestor) {
    const err = new Error("The original executed strategy for this edit could not be found.");
    err.code = "META_V2_STRATEGY_REQUIRED";
    throw err;
  }
  const { targetCampaignId, targetAdSetId, targetAdAccountId } = stored.resolvedAssets;
  const requestedChanges = stored.strategy.requestedChanges;

  markStrategyApproved(stored.id);
  try {
    setStrategyStatus(stored.id, "executing");

    // Re-verify the campaign still exists and is still PAUSED, immediately
    // before applying anything — never resumed as a side effect of this
    // read, and never proceeded past if it's no longer paused.
    const liveCampaign = await meta.getCampaign(accessToken, targetCampaignId);
    if (liveCampaign.status !== "PAUSED") {
      const err = new Error(`This campaign is currently "${liveCampaign.status}" in Meta, not PAUSED — it may have been resumed (or deleted and recreated) since this edit was proposed. Editing a running campaign isn't supported here; pause it in Ads Manager, then propose the edit again.`);
      err.code = "META_V2_EDIT_CAMPAIGN_NOT_PAUSED";
      throw err;
    }

    const liveAdSet = await meta.getAdSet(accessToken, targetAdSetId);
    if (liveAdSet.status !== "PAUSED") {
      const err = new Error(`This ad set is currently "${liveAdSet.status}" in Meta, not PAUSED — editing a running ad set isn't supported here.`);
      err.code = "META_V2_EDIT_ADSET_NOT_PAUSED";
      throw err;
    }

    // Same currency-drift discipline execute_strategy already applies at
    // creation time (round 30) — re-fetch the REAL, current currency via
    // the SAME bulk listAdAccounts lookup creation uses (never the
    // possibly-stale stored value alone), and refuse on a mismatch
    // instead of risking a wrong-magnitude spend change.
    const adAccounts = await meta.listAdAccounts(accessToken);
    const adAccount = adAccounts.find((a) => a.id === targetAdAccountId);
    if (!adAccount) {
      const err = new Error(`The ad account this campaign was built for (${targetAdAccountId}) is no longer connected.`);
      err.code = "META_V2_EDIT_ADACCOUNT_MISSING";
      throw err;
    }
    const builtForCurrency = ancestor.resolvedAssets?.adAccountCurrency;
    if (builtForCurrency && builtForCurrency !== adAccount.currency) {
      const err = new Error(`This campaign was built for a ${builtForCurrency} ad account, but the ad account's real currency is now ${adAccount.currency} — refusing to edit the budget rather than risk the wrong amount. Build a new strategy to pick up the current currency.`);
      err.code = "META_V2_EDIT_CURRENCY_MISMATCH";
      throw err;
    }
    const currency = adAccount.currency;

    const updateFields = {};
    const appliedChanges = {};
    const previousLiveValues = {};

    if ("budget_daily" in requestedChanges) {
      const expectedLiveMinor = toMetaBudgetMinorUnits(ancestor.strategy.budget_daily, currency);
      const actualLiveMinor = Number(liveAdSet.daily_budget);
      if (actualLiveMinor !== expectedLiveMinor) {
        const err = new Error(`The live daily budget has changed since this edit was proposed — Meta currently shows ${actualLiveMinor} (in the ad account's smallest currency unit), not the ${expectedLiveMinor} this app last knew about. Someone may have changed it directly in Ads Manager. Propose the edit again to work from the current value.`);
        err.code = "META_V2_EDIT_DRIFT_BUDGET";
        throw err;
      }
      const newMinor = toMetaBudgetMinorUnits(requestedChanges.budget_daily, currency);
      if (newMinor !== actualLiveMinor) {
        updateFields.daily_budget = newMinor;
        appliedChanges.budget_daily = requestedChanges.budget_daily;
        previousLiveValues.budget_daily = ancestor.strategy.budget_daily;
      }
    }

    const audienceFieldsTouched = ["gender", "age_min", "age_max", "countries"].filter((f) => f in requestedChanges);
    if (audienceFieldsTouched.length) {
      const expectedLiveTargeting = buildV2Targeting(ancestor.strategy);
      const drift = targetingDrift(liveAdSet.targeting, expectedLiveTargeting, audienceFieldsTouched);
      if (drift) {
        const err = new Error(`The live ${drift.field.replace(/_/g, " ")} has changed since this edit was proposed — Meta currently shows ${drift.liveValue}, not what this app last knew about. Someone may have changed it directly in Ads Manager. Propose the edit again to work from the current value.`);
        err.code = "META_V2_EDIT_DRIFT_AUDIENCE";
        throw err;
      }
      const mergedStrategy = buildMergedTargetingStrategy(requestedChanges, liveAdSet.targeting, ancestor.strategy);
      const newTargeting = buildV2Targeting(mergedStrategy);
      if (!targetingEquivalent(newTargeting, liveAdSet.targeting)) {
        updateFields.targeting = newTargeting;
        for (const f of audienceFieldsTouched) appliedChanges[f] = requestedChanges[f];
        previousLiveValues.gender = metaGendersToStrategyGender(liveAdSet.targeting?.genders);
        previousLiveValues.age_min = liveAdSet.targeting?.age_min ?? null;
        previousLiveValues.age_max = liveAdSet.targeting?.age_max ?? null;
        previousLiveValues.countries = liveAdSet.targeting?.geo_locations?.countries || [];
      }
    }

    // No-op guard — never fire a Meta call that changes nothing. In
    // practice the propose-time genuine-changes check plus the drift
    // checks above make this unreachable (if live matches our old record
    // and the new value differs from our old record, it must differ from
    // live too) — kept anyway as a real, independent backstop, not a
    // decoration, exactly as required.
    if (!Object.keys(updateFields).length) {
      const err = new Error("These values already match what's currently live on the ad set — nothing to change.");
      err.code = "META_V2_EDIT_NO_OP";
      throw err;
    }

    logger.info("meta_expert_v2.apply_campaign_edit.request", { strategyId: stored.id, adSetId: targetAdSetId, body: updateFields });
    // Meta's own error surfaces verbatim on failure — never swallowed,
    // never retried; the catch block below only records the row's own
    // status, it never alters or replaces the thrown error.
    await meta.updateAdSet(accessToken, targetAdSetId, updateFields);
    logger.info("meta_expert_v2.apply_campaign_edit.response", { strategyId: stored.id, adSetId: targetAdSetId });

    // Read-back verification AFTER the update — never infer success from
    // a 200. Confirms Meta actually applied exactly what was sent, not
    // just that the call didn't error.
    const verifyAdSet = await meta.getAdSet(accessToken, targetAdSetId);
    const verifyFailures = [];
    if ("daily_budget" in updateFields && Number(verifyAdSet.daily_budget) !== Number(updateFields.daily_budget)) {
      verifyFailures.push(`daily_budget: expected ${updateFields.daily_budget}, Meta now shows ${verifyAdSet.daily_budget}`);
    }
    if ("targeting" in updateFields && !targetingEquivalent(verifyAdSet.targeting, updateFields.targeting)) {
      verifyFailures.push(`targeting: the read-back does not match what was sent`);
    }
    if (verifyFailures.length) {
      const err = new Error(`Meta accepted the update, but the read-back doesn't confirm it actually applied: ${verifyFailures.join("; ")}. Do not assume this edit succeeded — check Ads Manager directly before relying on it.`);
      err.code = "META_V2_EDIT_VERIFY_FAILED";
      throw err;
    }

    const executionResult = { campaignId: targetCampaignId, adSetId: targetAdSetId, appliedChanges, previousLiveValues, status: "PAUSED" };
    markStrategyExecuted(stored.id, executionResult);
    publishEvent(userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_edited", campaignId: targetCampaignId, adSetId: targetAdSetId, appliedChanges, source: "meta_expert_v2" });
    return executionResult;
  } catch (err) {
    markStrategyFailed(stored.id, err.message);
    throw err;
  }
}
