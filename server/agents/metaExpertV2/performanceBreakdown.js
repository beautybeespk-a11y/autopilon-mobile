// Meta Ads Expert V2 — Phase 3A: granular performance reads.
//
// get_business_snapshot (businessSnapshot.js) gives an account-level
// rollup — enough to decide a NEW campaign's strategy, but not enough to
// answer "how is campaign X doing," "which ad set is spending the most,"
// or "how did last week compare to the week before." This module answers
// those.
//
// Scope for 3A, deliberately: reading and presenting only. No diagnosis,
// no recommendations, no actions (that's 3B/3C). The sorted "top by
// spend"/"worst by CPA" lists below are plain sorts of real numbers —
// never a verdict like "pause this."
//
// Same discipline round 49 already proved out for the account-level
// rollup, applied at this new level rather than reintroduced wrong:
//   - every rate is blended from real totals, never an average of
//     per-entity rates (a rate is never the average of rates when the
//     denominators differ — round 49's own proof).
//   - the raw totals a rate was computed from are always carried
//     alongside it — a rate with no visible denominator is how that bug
//     went unnoticed the first time.
//   - a metric Meta didn't return is null/absent, never substituted with
//     a guessed or defaulted number.
//
// Round 54 follow-up — two live production failures fixed here:
//   1. A date range that resolved to 30 real days was presented to the
//      customer as "last week"/"the week before." formatRangeLabel below
//      derives the period's NAME from the real resolved dates — a 30-day
//      window can never be called a week, by construction.
//   2. "which ad set is spending the most" (no campaign named) had no
//      path to a real answer — campaignId was required. gatherPerformanceBreakdown
//      now routes: a given campaignId scopes to it; omitted with exactly
//      one ACTIVE campaign resolves it automatically (a user asking about
//      "the campaign" when only one is active means that one); omitted
//      with 2+ active campaigns uses a verified-live account-wide ad-set
//      breakdown (Explorer, v25.0: /{adAccountId}/insights?level=adset
//      returns one row per ad set ACROSS ALL CAMPAIGNS, each carrying its
//      own real campaign_id/campaign_name) rather than asking which —
//      every ad set in that output is explicitly attributed to its real
//      campaign, the exact fact missing from the live bug this answers
//      (campaign data presented AS an ad set, with no campaign identity).
import * as meta from "../../integrations/meta/api.js";
import { resolveAdAccountId } from "../../tools/shared/metaAdAccountId.js";

export const DEFAULT_DATE_PRESET = "last_7d";

// Deliberately a LOCAL copy, not an import of businessSnapshot.js's own
// blendedRate — this round is additive only and doesn't touch round 49's
// code. Carries a numerator-null guard as defense-in-depth: totalsFromRow
// below (round 54 follow-up) now always supplies a real number (0 or
// higher) for every field, including purchases/revenue, for any row that
// genuinely exists — so this guard is never actually exercised through
// normal flow — but a rate must still never silently read as a real zero
// if a numerator were ever genuinely absent, so it stays.
function blendedRate(numerator, denominator, multiplier = 1) {
  if (numerator == null) return null;
  return denominator > 0 ? (numerator / denominator) * multiplier : null;
}

function ratesFromTotals(totals) {
  return {
    cpa: blendedRate(totals.spend, totals.purchases),
    roas: blendedRate(totals.revenue, totals.spend),
    ctr: blendedRate(totals.clicks, totals.impressions, 100),
    cpm: blendedRate(totals.spend, totals.impressions, 1000),
    cpc: blendedRate(totals.spend, totals.clicks),
    frequency: blendedRate(totals.impressions, totals.reach),
    // Stream D — CVR is a percent (same convention as CTR: *100), AOV is
    // in account-currency units (same convention as CPC: no multiplier).
    // Both reuse blendedRate, so the null/zero rules are identical to
    // every other rate: null numerator -> null; zero denominator -> null;
    // a real 0 numerator over a real denominator -> honest 0 (e.g. CVR 0%
    // on 234 clicks with 0 purchases is a real result, never "unknown").
    // AOV is null (not 0) when purchases are 0 — dividing by zero
    // purchases is undefined, exactly like CPA today.
    cvr: blendedRate(totals.purchases, totals.clicks, 100),
    aov: blendedRate(totals.revenue, totals.purchases),
  };
}

// Round 54 follow-up (live production report): a prior week with real
// spend (587.41) and no purchase action was reported to the customer as
// purchases/revenue "not available" — literally true of the raw API
// field (Meta's actions array simply omits a type with zero occurrences,
// per extractActionValue's own comment, api.js), but misleading as a
// customer-facing fact: "not available" reads as a measurement gap,
// when this is actually a verified performance result — real spend,
// zero conversions.
//
// This function is ONLY ever called for a row that EXISTS (a real
// insights row Meta actually returned — spend/clicks/impressions/reach
// are real numbers here by construction). The OTHER case — no row at
// all, genuinely nothing measured — is handled one level up, entirely
// separately (noActivityInRange:true, totals set to null for the WHOLE
// entity, never routed through this function). So within a real row,
// an absent purchase/revenue action type is unambiguous: Meta's own
// convention is that a real row lists only action types that actually
// occurred, never a fixed schema backfilled with zeros — so "absent" IS
// "zero occurrences," not "unknown." purchases/revenue are therefore 0
// here, a real fact, never null (null is reserved exclusively for the
// genuinely-no-row case this function never sees).
function totalsFromRow(row) {
  return {
    spend: Number(row.spend) || 0,
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    purchases: row.purchases ?? 0,
    revenue: row.revenue ?? 0,
  };
}

function entityFromRow(row, idField, nameField) {
  const totals = totalsFromRow(row);
  return { id: row[idField], name: row[nameField], totals, rates: ratesFromTotals(totals), dateStart: row.date_start || null, dateStop: row.date_stop || null };
}

function resolveDateParams({ datePreset, since, until } = {}) {
  // Stream D — a half-given custom range used to be silently dropped in
  // favour of last_7d. That is now a loud error: the caller meant a
  // specific range and got a different one.
  if ((since && !until) || (!since && until)) {
    const err = new Error(`A custom date range needs both since and until (YYYY-MM-DD) — got only ${since ? `since=${since}` : `until=${until}`}.`);
    err.code = "META_V2_DATE_RANGE_INCOMPLETE";
    throw err;
  }
  if (since && until) return { since, until, requestedExplicitRange: true };
  return { datePreset: datePreset || DEFAULT_DATE_PRESET, requestedExplicitRange: false, defaultedTo: datePreset || DEFAULT_DATE_PRESET };
}

// Pure date arithmetic on REAL resolved dates (Meta's own date_start/
// date_stop for the current call — never derived from a relative
// date_preset string, which this code has no business doing math on
// itself) — computes the immediately preceding window of equal length.
function priorPeriod(since, until) {
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  const spanMs = end.getTime() - start.getTime();
  const priorUntil = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const priorSince = new Date(priorUntil.getTime() - spanMs);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { since: fmt(priorSince), until: fmt(priorUntil) };
}

function percentChange(current, prior) {
  if (current == null || prior == null) return null;
  if (prior === 0) return current === 0 ? 0 : null; // no honest percentage from a zero base — never invented as Infinity
  return ((current - prior) / prior) * 100;
}

// Live production bug: a real last_30d-resolved range ("September 9 to
// October 8") was described to the customer as "last week"/"the week
// before." Deterministic fix — the period's NAME is derived from the
// REAL resolved span, never written freely by the model. Exactly 7 days
// is the only case allowed to say "week"; everything else states the
// real day count and dates, in natural prose ("the 30 days from 9 Sep to
// 8 Oct"), not a mechanical date dump.
function spanDaysBetween(since, until) {
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}
function formatDateHuman(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
}
export function formatRangeLabel(since, until) {
  if (!since || !until) return null;
  const days = spanDaysBetween(since, until);
  const d1 = formatDateHuman(since);
  const d2 = formatDateHuman(until);
  return days === 7 ? `the past week (${d1} to ${d2})` : `the ${days} days from ${d1} to ${d2}`;
}

// Plain sorts of real numbers for "which ad set/ad is spending the most /
// converting worst" — scoped to entities that actually had activity in
// the range (sorting a no-activity entity in here would be presenting a
// fact Meta never reported). Never a recommendation — that's 3B/3C.
// campaignId/campaignName are carried through whenever the entity itself
// has them (always true for ad sets from round 54 on, campaign-scoped or
// account-wide alike) — "ad set X is spending the most" is not a useful
// fact without knowing which campaign it belongs to, the exact thing
// missing from the live bug this round fixes.
function topBySpend(entities, n = 3) {
  return [...entities].sort((a, b) => b.totals.spend - a.totals.spend).slice(0, n)
    .map((e) => ({ id: e.id, name: e.name, spend: e.totals.spend, campaignId: e.campaignId ?? null, campaignName: e.campaignName ?? null }));
}
function worstByCpa(entities, n = 3) {
  return entities.filter((e) => e.rates.cpa != null).sort((a, b) => b.rates.cpa - a.rates.cpa).slice(0, n)
    .map((e) => ({ id: e.id, name: e.name, cpa: e.rates.cpa, campaignId: e.campaignId ?? null, campaignName: e.campaignName ?? null }));
}

// --- Phase 3B (round 55): deterministic diagnosis ------------------------
//
// 3A (above) reads honestly. This teaches the agent to JUDGE what it
// reads — RECOMMENDATIONS ONLY, never an action (pausing/budget changes
// are 3C, not built here). Investigated and reported before coding;
// exactly two sources of judgement are allowed, matching that report:
//
//   1. The account's OWN data — this period vs. prior periods, this
//      entity vs. its siblings in the same account. Everything below
//      reads only fields gatherForOneCampaign/gatherAccountWideAdSets
//      already fetch (plus campaign.created_time, one additive field).
//   2. Structural rules that need no external benchmark — mechanical
//      facts about a ratio (frequency) or a sample size (clicks), never
//      "good CPA for beauty in Pakistan is X."
//
// Investigated and explicitly rejected: Meta's public Marketing API (what
// this file calls) has no industry-benchmark or auction-ranking endpoint
// for a third-party app's own access token. No real source exists, so
// none is used — the alternative (an invented number) is fabrication
// wearing a different hat, the exact pattern this project has already
// been burned by.
//
// Every finding below states the real number it rests on AND the
// threshold that was crossed — a bare verdict is never acceptable here;
// a user who disagrees with a threshold needs to be able to see it.
const ZERO_CONVERSION_CLICKS_THRESHOLD = 50;
// Clicks, not a spend amount — a currency figure means something
// ~280x different depending on the account's currency (round 54
// follow-up's PKR/$ bug proved this directly), so it can never be the
// THRESHOLD, only something reported alongside one. Clicks are
// currency-agnostic. 50 is a sample-size argument, not a performance
// judgement: zero purchases across 50 real clicks is a pattern worth
// naming, not two unlucky non-converters.
const FATIGUE_FREQUENCY_THRESHOLD = 3.0;
// A mechanical fact about the ratio itself (impressions/reach) — "the
// average person in this audience has now seen this ad 3+ times" — not
// a comparison to any outside benchmark.
const CTR_DECLINE_PCT_THRESHOLD = -20;
// Campaign-level only this round: the only granularity where a real
// prior-period CTR exists today (comparison.deltas below). Ad-set/ad
// level would need a new prior-period fetch at that granularity —
// deferred as its own decision, not built here (see this round's
// investigation report).
const BUDGET_CONCENTRATION_SHARE_THRESHOLD = 0.5;
const WORSE_CPA_MARGIN = 1.2; // the top spender's CPA must be >=20% worse
// Both noise filters, not quality judgements: without them, a trivial
// 2% spend-share or CPA gap between two ad sets would get surfaced as if
// it meant something. They decide whether a difference is WORTH NAMING,
// never whether a number is "good."
const MIN_CAMPAIGN_AGE_DAYS_FOR_TREND = 14;

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function diagnoseZeroConversions(entity, scopeLabel) {
  if (!entity.totals || entity.noActivityInRange) return null;
  if (entity.totals.purchases !== 0) return null;
  if (entity.totals.clicks < ZERO_CONVERSION_CLICKS_THRESHOLD) return null;
  return {
    type: "zero_conversions",
    scope: scopeLabel,
    entityId: entity.id,
    entityName: entity.name,
    message: `${entity.name}: ${entity.totals.clicks} clicks and 0 purchases (spend ${entity.totals.spend}) — zero conversions on ${entity.totals.clicks} clicks clears the ${ZERO_CONVERSION_CLICKS_THRESHOLD}-click sample-size threshold, so this is a real result, not a data gap.`,
  };
}

// Reach qualifier is RELATIVE to this entity's own siblings in the same
// account/campaign, never an absolute cutoff — an absolute "small reach"
// number would be exactly as unjustified as an invented benchmark.
// otherReaches excludes the entity itself. With no siblings to compare
// against, frequency alone is still reported (it's a real fact about the
// ratio regardless of audience size) — just without a relative-reach claim.
function diagnoseFatigue(entity, scopeLabel, otherReaches) {
  if (!entity.rates || entity.noActivityInRange) return null;
  const freq = entity.rates.frequency;
  if (freq == null || freq < FATIGUE_FREQUENCY_THRESHOLD) return null;
  const reach = entity.totals.reach;
  if (otherReaches && otherReaches.length > 0) {
    const med = median(otherReaches);
    if (reach > med) return null; // not small relative to its peers — no finding
    return {
      type: "creative_fatigue",
      scope: scopeLabel,
      entityId: entity.id,
      entityName: entity.name,
      message: `${entity.name}: frequency ${freq.toFixed(2)} exceeds the ${FATIGUE_FREQUENCY_THRESHOLD} fatigue threshold, on a reach of ${reach} — at or below the median reach (${med}) of its ${otherReaches.length} other ${scopeLabel}(s) with activity this period. The same people are seeing this repeatedly more than most of its peers; consider new creative.`,
    };
  }
  return {
    type: "creative_fatigue",
    scope: scopeLabel,
    entityId: entity.id,
    entityName: entity.name,
    message: `${entity.name}: frequency ${freq.toFixed(2)} exceeds the ${FATIGUE_FREQUENCY_THRESHOLD} fatigue threshold (reach ${reach}; no other ${scopeLabel} with activity this period to compare reach against). Consider new creative.`,
  };
}

function diagnoseCtrDecline(comparison, campaign) {
  if (!comparison || comparison.unavailable || !comparison.deltas) return null;
  const ctrPct = comparison.deltas.ctrPct;
  if (ctrPct == null || ctrPct > CTR_DECLINE_PCT_THRESHOLD) return null;
  return {
    type: "ctr_decline",
    scope: "campaign",
    entityId: campaign.id,
    entityName: campaign.name,
    message: `${campaign.name}: CTR fell ${ctrPct.toFixed(1)}% period over period, from ${comparison.prior.rates.ctr.toFixed(2)}% to ${comparison.current.rates.ctr.toFixed(2)}% — clears the ${CTR_DECLINE_PCT_THRESHOLD}% decline threshold. A falling click-through rate period over period usually signals the creative is wearing out.`,
  };
}

// At most one finding per sibling group — the group's OWN numbers only,
// no external anchor. share/margin are noise filters (see their own
// comments above), never a claim about what a "good" CPA is.
function diagnoseBudgetConcentration(entities, scopeLabel) {
  const active = entities.filter((e) => !e.noActivityInRange && e.totals && e.totals.spend > 0);
  if (active.length < 2) return null;
  const totalSpend = active.reduce((sum, e) => sum + e.totals.spend, 0);
  if (totalSpend <= 0) return null;
  const top = [...active].sort((a, b) => b.totals.spend - a.totals.spend)[0];
  const share = top.totals.spend / totalSpend;
  if (share < BUDGET_CONCENTRATION_SHARE_THRESHOLD || top.rates.cpa == null) return null;
  const others = active.filter((e) => e.id !== top.id && e.rates.cpa != null);
  if (!others.length) return null;
  const bestOther = others.reduce((best, e) => (e.rates.cpa < best.rates.cpa ? e : best));
  if (bestOther.rates.cpa <= 0 || top.rates.cpa < bestOther.rates.cpa * WORSE_CPA_MARGIN) return null;
  return {
    type: "budget_concentration",
    scope: scopeLabel,
    entityId: top.id,
    entityName: top.name,
    message: `${top.name} consumes ${(share * 100).toFixed(0)}% of total ${scopeLabel} spend — clears the ${(BUDGET_CONCENTRATION_SHARE_THRESHOLD * 100).toFixed(0)}% concentration threshold — at a CPA of ${top.rates.cpa.toFixed(2)}, which is ${(top.rates.cpa / bestOther.rates.cpa).toFixed(1)}x ${bestOther.name}'s ${bestOther.rates.cpa.toFixed(2)} — clears the ${WORSE_CPA_MARGIN}x worse-CPA threshold. Most of the budget is going to the less efficient option.`,
  };
}

// Only relevant when a trend was actually requested (compareToPriorPeriod)
// — current-period-only findings (zero-conversion, fatigue, budget
// concentration) don't need campaign age at all, so this never suppresses
// those. "Three weeks of history on one campaign cannot support a
// confident trend claim" — this is that rule, in code rather than left to
// the model's judgement.
function diagnoseInsufficientHistoryForTrend(campaign) {
  if (!campaign.createdTime) return null;
  const ageDays = Math.floor((Date.now() - new Date(campaign.createdTime).getTime()) / 86400000);
  if (ageDays >= MIN_CAMPAIGN_AGE_DAYS_FOR_TREND) return null;
  return {
    type: "insufficient_data",
    scope: "campaign",
    entityId: campaign.id,
    entityName: campaign.name,
    message: `${campaign.name} is only ${ageDays} day(s) old — below the ${MIN_CAMPAIGN_AGE_DAYS_FOR_TREND}-day threshold for a confident trend judgement. The numbers above are real, but there isn't enough history yet to call a period-over-period trend.`,
  };
}

// Stream D — Test 2's dead end: "no recorded activity in the last week"
// with no next step, when the campaign's real activity was three weeks
// earlier. Meta returns no row at all for a no-activity window (api.js),
// so the ONLY way to answer "when DID it run" is a second, wide probe.
// Runs ONLY when the requested window had no row (one extra insights
// call, campaign level only — never per ad set/ad), and reports exactly
// what the probe covered so "first activity in the last 90 days" is
// never presented as "first activity ever".
async function getCampaignActivityWindow(accessToken, campaignId, createdTime) {
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const createdDate = createdTime ? new Date(createdTime).toISOString().slice(0, 10) : null;
  // Probe from the later of (campaign creation, 90 days ago): bounded cost,
  // and `complete` says honestly whether the probe reaches back to creation.
  const probeSince = createdDate && createdDate > ninetyDaysAgo ? createdDate : ninetyDaysAgo;
  const probeUntil = today;
  const rows = await meta.getCampaignLevelInsights(accessToken, campaignId, { since: probeSince, until: probeUntil });
  const row = rows[0] || null;
  if (!row) {
    return { hasActivity: false, firstActivityDate: null, lastActivityDate: null, probeSince, probeUntil, complete: Boolean(createdDate && createdDate >= ninetyDaysAgo), label: null };
  }
  return {
    hasActivity: true,
    firstActivityDate: row.date_start || null,
    lastActivityDate: row.date_stop || null,
    probeSince,
    probeUntil,
    complete: Boolean(createdDate && createdDate >= ninetyDaysAgo),
    label: formatRangeLabel(row.date_start, row.date_stop),
  };
}

async function gatherForOneCampaign(accessToken, campaignId, dateParams, compareToPriorPeriod) {
  const campaign = await meta.getCampaign(accessToken, campaignId);

  const [campaignRows, adSetRows, adRows, fullAdSetRoster, fullAdRoster, adAccount] = await Promise.all([
    meta.getCampaignLevelInsights(accessToken, campaignId, dateParams),
    meta.getAdSetLevelInsights(accessToken, campaignId, dateParams),
    meta.getAdLevelInsights(accessToken, campaignId, dateParams),
    meta.listAdSets(accessToken, campaign.account_id),
    meta.listAds(accessToken, campaign.account_id),
    meta.getAdAccount(accessToken, campaign.account_id),
  ]);

  const campaignRow = campaignRows[0] || null;
  const campaignSummary = campaignRow
    ? { ...entityFromRow(campaignRow, "campaign_id", "campaign_name"), id: campaign.id, name: campaign.name, noActivityInRange: false }
    : { id: campaign.id, name: campaign.name, totals: null, rates: null, dateStart: null, dateStop: null, noActivityInRange: true };

  // Stream D — when the requested window has no row, recover the real
  // activity window instead of leaving resolvedSince/Until/label null
  // with no next step. `campaign.created_time` comes from getCampaign()
  // (api.js) — no extra call to learn it.
  if (campaignSummary.noActivityInRange) {
    campaignSummary.activityWindow = await getCampaignActivityWindow(accessToken, campaignId, campaign.created_time);
  } else {
    campaignSummary.activityWindow = {
      hasActivity: true,
      firstActivityDate: campaignSummary.dateStart,
      lastActivityDate: campaignSummary.dateStop,
      probeSince: campaignSummary.dateStart,
      probeUntil: campaignSummary.dateStop,
      complete: true,
      label: formatRangeLabel(campaignSummary.dateStart, campaignSummary.dateStop),
    };
  }

  // The real, complete roster (round 50's listAdSets/listAds) filtered to
  // THIS campaign — cross-referenced against which ones actually had an
  // insights row, so a paused/inactive ad set or ad is reported as "no
  // activity in this range," never silently omitted and never implied to
  // have spent zero.
  const adSetsUnderCampaign = fullAdSetRoster.filter((a) => a.campaign_id === campaignId);
  const adsUnderCampaign = fullAdRoster.filter((a) => a.campaign_id === campaignId);

  const adSetsWithActivity = adSetRows.map((row) => {
    const roster = adSetsUnderCampaign.find((a) => a.id === row.adset_id);
    return { ...entityFromRow(row, "adset_id", "adset_name"), campaignId: campaign.id, campaignName: campaign.name, status: roster?.status ?? null, noActivityInRange: false };
  });
  const activeAdSetIds = new Set(adSetsWithActivity.map((a) => a.id));
  const adSetsWithNoActivity = adSetsUnderCampaign
    .filter((a) => !activeAdSetIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, status: a.status, campaignId: campaign.id, campaignName: campaign.name, totals: null, rates: null, noActivityInRange: true }));

  const adsWithActivity = adRows.map((row) => {
    const roster = adsUnderCampaign.find((a) => a.id === row.ad_id);
    return { ...entityFromRow(row, "ad_id", "ad_name"), adSetId: row.adset_id || roster?.adset_id || null, campaignId: campaign.id, campaignName: campaign.name, status: roster?.status ?? null, noActivityInRange: false };
  });
  const activeAdIds = new Set(adsWithActivity.map((a) => a.id));
  const adsWithNoActivity = adsUnderCampaign
    .filter((a) => !activeAdIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, status: a.status, adSetId: a.adset_id || null, campaignId: campaign.id, campaignName: campaign.name, totals: null, rates: null, noActivityInRange: true }));

  let comparison = null;
  if (compareToPriorPeriod) {
    if (campaignSummary.dateStart && campaignSummary.dateStop) {
      const prior = priorPeriod(campaignSummary.dateStart, campaignSummary.dateStop);
      const priorRows = await meta.getCampaignLevelInsights(accessToken, campaignId, prior);
      const priorRow = priorRows[0] || null;
      const priorTotals = priorRow ? totalsFromRow(priorRow) : null;
      const priorRates = priorTotals ? ratesFromTotals(priorTotals) : null;
      comparison = {
        currentRange: { since: campaignSummary.dateStart, until: campaignSummary.dateStop, label: formatRangeLabel(campaignSummary.dateStart, campaignSummary.dateStop) },
        priorRange: { ...prior, label: formatRangeLabel(prior.since, prior.until) },
        current: { totals: campaignSummary.totals, rates: campaignSummary.rates },
        prior: priorTotals ? { totals: priorTotals, rates: priorRates } : null,
        priorHadNoActivity: !priorTotals,
        priorUnavailableReason: priorTotals ? null : "The immediately preceding window had no recorded activity, so there is no prior-period total to compare against — the current period's numbers stand on their own.",
        deltas: priorTotals ? {
          spendPct: percentChange(campaignSummary.totals.spend, priorTotals.spend),
          purchasesPct: percentChange(campaignSummary.totals.purchases, priorTotals.purchases),
          cpaPct: percentChange(campaignSummary.rates.cpa, priorRates.cpa),
          roasPct: percentChange(campaignSummary.rates.roas, priorRates.roas),
          // Round 55 (Phase 3B) — added so diagnoseCtrDecline below has a
          // real delta to read; frequencyPct carried alongside for the
          // same reason diagnosis text always ships its own numbers.
          ctrPct: percentChange(campaignSummary.rates.ctr, priorRates.ctr),
          frequencyPct: percentChange(campaignSummary.rates.frequency, priorRates.frequency),
          // Stream D — CPC/CPM/CVR/AOV deltas, same plain percentChange
          // (null on a zero base — "AOV rose from 0 purchases" has no
          // honest percentage; the reply must say "from 0 purchases to 8",
          // never invent one).
          cpcPct: percentChange(campaignSummary.rates.cpc, priorRates.cpc),
          cpmPct: percentChange(campaignSummary.rates.cpm, priorRates.cpm),
          cvrPct: percentChange(campaignSummary.rates.cvr, priorRates.cvr),
          aovPct: percentChange(campaignSummary.rates.aov, priorRates.aov),
        } : null,
      };
    } else {
      const window = campaignSummary.activityWindow;
      const windowLabel = window && (window.label || (window.firstActivityDate && window.lastActivityDate ? `${window.firstActivityDate} to ${window.lastActivityDate}` : "on dates Meta did not return"));
      comparison = {
        unavailable: true,
        reason: window && window.hasActivity
          ? `No activity in the current range, so there's no resolved date range to compare a prior period against. This campaign's most recent recorded activity was ${windowLabel} (probed ${window.probeSince} to ${window.probeUntil}${window.complete ? "" : " — the probe only reaches back 90 days, so earlier activity is not ruled out"}). Ask for that window by its dates to compare it.`
          : `No activity in the current range, so there's no resolved date range to compare a prior period against. No recorded activity was found in the probe window ${window ? `${window.probeSince} to ${window.probeUntil}` : ""} either.`,
      };
    }
  }

  // Phase 3B diagnosis — see this file's own header comment above
  // gatherForOneCampaign for the full design. Current-period rules
  // (zero-conversion, fatigue, budget concentration) apply regardless of
  // campaign age; only the TREND rule (CTR decline) is suppressed by
  // insufficientHistory, since that's the only one a young campaign
  // genuinely can't support.
  const insufficientHistory = compareToPriorPeriod ? diagnoseInsufficientHistoryForTrend({ id: campaign.id, name: campaign.name, createdTime: campaign.created_time }) : null;
  const diagnosis = [
    insufficientHistory,
    diagnoseZeroConversions(campaignSummary, "campaign"),
    diagnoseFatigue(campaignSummary, "campaign", []),
    insufficientHistory ? null : diagnoseCtrDecline(comparison, campaign),
    ...adSetsWithActivity.map((a) => diagnoseZeroConversions(a, "ad set")),
    ...adSetsWithActivity.map((a) => diagnoseFatigue(a, "ad set", adSetsWithActivity.filter((o) => o.id !== a.id).map((o) => o.totals.reach))),
    diagnoseBudgetConcentration(adSetsWithActivity, "ad set"),
    ...adsWithActivity.map((a) => diagnoseZeroConversions(a, "ad")),
    ...adsWithActivity.map((a) => diagnoseFatigue(a, "ad", adsWithActivity.filter((o) => o.id !== a.id).map((o) => o.totals.reach))),
    diagnoseBudgetConcentration(adsWithActivity, "ad"),
  ].filter(Boolean);

  return {
    scope: "campaign",
    // Round 54 follow-up (live production report): every figure in a
    // reply rendered with a "$" on a real PKR account — a misread of
    // roughly 280x. The account's REAL currency (never model-authored)
    // travels with the data itself now, the same way dateRange.label
    // carries the real resolved period — see orchestrator/index.js's
    // currency gate, which now also reads this field.
    currency: adAccount.currency || null,
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, objective: campaign.objective },
    dateRange: { requested: dateParams, requestedExplicitRange: Boolean(dateParams.requestedExplicitRange), defaultedTo: dateParams.defaultedTo || null, resolvedSince: campaignSummary.dateStart, resolvedUntil: campaignSummary.dateStop, label: formatRangeLabel(campaignSummary.dateStart, campaignSummary.dateStop), activityWindow: campaignSummary.activityWindow || null },
    campaignSummary,
    adSets: [...adSetsWithActivity, ...adSetsWithNoActivity],
    ads: [...adsWithActivity, ...adsWithNoActivity],
    topAdSetsBySpend: topBySpend(adSetsWithActivity),
    worstAdSetsByCpa: worstByCpa(adSetsWithActivity),
    topAdsBySpend: topBySpend(adsWithActivity),
    worstAdsByCpa: worstByCpa(adsWithActivity),
    comparison,
    diagnosis,
  };
}

// Round 54 follow-up — campaignId omitted, 2+ campaigns genuinely active
// at once: there is no single campaign to default to, so this answers
// "which ad set is spending the most" across the WHOLE account instead
// of asking which campaign (verified live, not guessed — see this file's
// header comment). Every ad set is explicitly attributed to its real
// campaign (campaignId/campaignName) — the exact fact missing from the
// live bug this fixes (campaign data presented AS an ad set).
async function gatherAccountWideAdSets(accessToken, adAccountId, dateParams) {
  const [rows, fullAdSetRoster, campaigns, adAccount] = await Promise.all([
    meta.getAccountAdSetLevelInsights(accessToken, adAccountId, dateParams),
    meta.listAdSets(accessToken, adAccountId),
    meta.listCampaigns(accessToken, adAccountId),
    meta.getAdAccount(accessToken, adAccountId),
  ]);
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const adSetsWithActivity = rows.map((row) => {
    const roster = fullAdSetRoster.find((a) => a.id === row.adset_id);
    const campaign = campaignById.get(row.campaign_id);
    return {
      ...entityFromRow(row, "adset_id", "adset_name"),
      campaignId: row.campaign_id || null,
      campaignName: row.campaign_name || campaign?.name || null,
      status: roster?.status ?? null,
      noActivityInRange: false,
    };
  });
  const activeIds = new Set(adSetsWithActivity.map((a) => a.id));
  const adSetsWithNoActivity = fullAdSetRoster
    .filter((a) => !activeIds.has(a.id))
    .map((a) => ({
      id: a.id, name: a.name, status: a.status,
      campaignId: a.campaign_id || null, campaignName: campaignById.get(a.campaign_id)?.name || null,
      totals: null, rates: null, noActivityInRange: true,
    }));

  const allAdSets = [...adSetsWithActivity, ...adSetsWithNoActivity];
  const resolvedSince = rows[0]?.date_start || null;
  const resolvedUntil = rows[0]?.date_stop || null;

  // Phase 3B diagnosis — no compareToPriorPeriod support at this scope
  // (gatherPerformanceBreakdown already refuses that combination before
  // this function is ever called), so no trend rule and no campaign-age
  // guard applies here — only the current-period rules, same as above.
  const diagnosis = [
    ...adSetsWithActivity.map((a) => diagnoseZeroConversions(a, "ad set")),
    ...adSetsWithActivity.map((a) => diagnoseFatigue(a, "ad set", adSetsWithActivity.filter((o) => o.id !== a.id).map((o) => o.totals.reach))),
    diagnoseBudgetConcentration(adSetsWithActivity, "ad set"),
  ].filter(Boolean);

  return {
    scope: "account_wide",
    adAccountId,
    // See gatherForOneCampaign's own comment — the real account currency
    // travels with the data, never left to the model to guess/default.
    currency: adAccount.currency || null,
    dateRange: { requested: dateParams, requestedExplicitRange: Boolean(dateParams.requestedExplicitRange), defaultedTo: dateParams.defaultedTo || null, resolvedSince, resolvedUntil, label: formatRangeLabel(resolvedSince, resolvedUntil), activityWindow: null },
    adSets: allAdSets,
    topAdSetsBySpend: topBySpend(adSetsWithActivity),
    worstAdSetsByCpa: worstByCpa(adSetsWithActivity),
    diagnosis,
  };
}

// Stream D — a campaign the user NAMES must resolve regardless of status.
// The model only ever knows the name ("BeautyBees – Website Sales") from
// the conversation/snapshot; before this, the only scope key was a numeric
// campaignId the model had no way to know, so a paused named campaign was
// unreachable and the no-id path (ACTIVE-only, below) threw instead.
// Matching is deterministic, never fuzzy: exact-after-normalisation wins,
// then a UNIQUE substring match; 0 or 2+ matches are errors that list the
// real names, never a silent first-match pick. Status is deliberately NOT
// a filter here — a paused campaign has real history worth reporting.
function normalizeCampaignName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function resolveCampaignByName(accessToken, { userId, campaignName }) {
  const adAccountId = await resolveAdAccountId({ userId, accessToken, providedAdAccountId: undefined });
  const campaigns = await meta.listCampaigns(accessToken, adAccountId);
  const wanted = normalizeCampaignName(campaignName);
  const exact = campaigns.filter((c) => normalizeCampaignName(c.name) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const err = new Error(`Multiple campaigns are named "${campaignName}" (${exact.map((c) => `${c.name} [${c.id}, ${c.status}]`).join("; ")}). Name one by its exact name, or pass its campaignId.`);
    err.code = "META_V2_CAMPAIGN_AMBIGUOUS";
    err.candidates = exact.map((c) => ({ id: c.id, name: c.name, status: c.status }));
    throw err;
  }
  const partial = campaigns.filter((c) => normalizeCampaignName(c.name).includes(wanted) || wanted.includes(normalizeCampaignName(c.name)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const err = new Error(`"${campaignName}" matches more than one campaign (${partial.map((c) => `${c.name} [${c.id}, ${c.status}]`).join("; ")}). Name one by its exact name, or pass its campaignId.`);
    err.code = "META_V2_CAMPAIGN_AMBIGUOUS";
    err.candidates = partial.map((c) => ({ id: c.id, name: c.name, status: c.status }));
    throw err;
  }
  const err = new Error(`No campaign named "${campaignName}" exists in this ad account. Real campaigns: ${campaigns.length ? campaigns.map((c) => `${c.name} [${c.status}]`).join("; ") : "(none)"}.`);
  err.code = "META_V2_CAMPAIGN_NOT_FOUND";
  err.candidates = campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status }));
  throw err;
}

export async function gatherPerformanceBreakdown(accessToken, { userId, campaignId, campaignName, datePreset, since, until, compareToPriorPeriod } = {}) {
  const dateParams = resolveDateParams({ datePreset, since, until });

  // campaignId wins when both are given (it is already unambiguous).
  // A bare numeric campaignName is treated as an id, not a name.
  if (campaignName && !campaignId && /^\d+$/.test(String(campaignName).trim())) {
    campaignId = String(campaignName).trim();
    campaignName = undefined;
  }
  if (campaignName && !campaignId) {
    const campaign = await resolveCampaignByName(accessToken, { userId, campaignName });
    return gatherForOneCampaign(accessToken, campaign.id, dateParams, compareToPriorPeriod);
  }
  if (campaignId) {
    return gatherForOneCampaign(accessToken, campaignId, dateParams, compareToPriorPeriod);
  }

  // No campaignId given — resolve deterministically rather than asking:
  // exactly one ACTIVE campaign -> use it (a user asking about "the
  // campaign" when only one is active means that one, even once the
  // account-wide path below exists); 2+ active -> the real, verified
  // account-wide ad-set breakdown, never a question back to the user
  // (Meta itself can answer this directly); 0 active -> genuinely
  // nothing to resolve automatically.
  const adAccountId = await resolveAdAccountId({ userId, accessToken, providedAdAccountId: undefined });
  const campaigns = await meta.listCampaigns(accessToken, adAccountId);
  const activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE");

  if (activeCampaigns.length === 1) {
    return gatherForOneCampaign(accessToken, activeCampaigns[0].id, dateParams, compareToPriorPeriod);
  }
  if (activeCampaigns.length === 0) {
    // Stream D — the old code threw here even when the account HAS
    // campaigns, just none ACTIVE (the exact Test 2 shape: one paused
    // campaign, user asking about "the campaign"). Exactly one campaign
    // of ANY status is still unambiguous — use it. Otherwise list the
    // real names so the next turn can pass campaignName instead of
    // throwing a bare "name a campaign" with nothing to name.
    if (campaigns.length === 1) {
      return gatherForOneCampaign(accessToken, campaigns[0].id, dateParams, compareToPriorPeriod);
    }
    const err = new Error(
      campaigns.length
        ? `campaignId was not given, and no ACTIVE campaign exists to resolve automatically. Name one specific campaign — real campaigns: ${campaigns.map((c) => `${c.name} [${c.status}]`).join("; ")}.`
        : "campaignId was not given, and no campaign exists in this ad account at all — name a specific campaign to get its breakdown."
    );
    err.code = "META_V2_CAMPAIGN_ID_REQUIRED";
    err.candidates = campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status }));
    throw err;
  }
  if (compareToPriorPeriod) {
    const err = new Error("compareToPriorPeriod needs one specific campaign — pass campaignId for a period comparison; the account-wide breakdown (multiple active campaigns, no campaignId) doesn't support a period comparison yet.");
    err.code = "META_V2_COMPARISON_NEEDS_CAMPAIGN";
    throw err;
  }
  return gatherAccountWideAdSets(accessToken, adAccountId, dateParams);
}
