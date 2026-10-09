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
  if (since && until) return { since, until };
  return { datePreset: datePreset || DEFAULT_DATE_PRESET };
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
        deltas: priorTotals ? {
          spendPct: percentChange(campaignSummary.totals.spend, priorTotals.spend),
          purchasesPct: percentChange(campaignSummary.totals.purchases, priorTotals.purchases),
          cpaPct: percentChange(campaignSummary.rates.cpa, priorRates.cpa),
          roasPct: percentChange(campaignSummary.rates.roas, priorRates.roas),
        } : null,
      };
    } else {
      comparison = { unavailable: true, reason: "No activity in the current range, so there's no resolved date range to compare a prior period against." };
    }
  }

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
    dateRange: { requested: dateParams, resolvedSince: campaignSummary.dateStart, resolvedUntil: campaignSummary.dateStop, label: formatRangeLabel(campaignSummary.dateStart, campaignSummary.dateStop) },
    campaignSummary,
    adSets: [...adSetsWithActivity, ...adSetsWithNoActivity],
    ads: [...adsWithActivity, ...adsWithNoActivity],
    topAdSetsBySpend: topBySpend(adSetsWithActivity),
    worstAdSetsByCpa: worstByCpa(adSetsWithActivity),
    topAdsBySpend: topBySpend(adsWithActivity),
    worstAdsByCpa: worstByCpa(adsWithActivity),
    comparison,
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

  return {
    scope: "account_wide",
    adAccountId,
    // See gatherForOneCampaign's own comment — the real account currency
    // travels with the data, never left to the model to guess/default.
    currency: adAccount.currency || null,
    dateRange: { requested: dateParams, resolvedSince, resolvedUntil, label: formatRangeLabel(resolvedSince, resolvedUntil) },
    adSets: allAdSets,
    topAdSetsBySpend: topBySpend(adSetsWithActivity),
    worstAdSetsByCpa: worstByCpa(adSetsWithActivity),
  };
}

export async function gatherPerformanceBreakdown(accessToken, { userId, campaignId, datePreset, since, until, compareToPriorPeriod } = {}) {
  const dateParams = resolveDateParams({ datePreset, since, until });

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
    const err = new Error("campaignId was not given, and no ACTIVE campaign exists to resolve automatically — name a specific campaign (including a paused one) to get its breakdown.");
    err.code = "META_V2_CAMPAIGN_ID_REQUIRED";
    throw err;
  }
  if (compareToPriorPeriod) {
    const err = new Error("compareToPriorPeriod needs one specific campaign — pass campaignId for a period comparison; the account-wide breakdown (multiple active campaigns, no campaignId) doesn't support a period comparison yet.");
    err.code = "META_V2_COMPARISON_NEEDS_CAMPAIGN";
    throw err;
  }
  return gatherAccountWideAdSets(accessToken, adAccountId, dateParams);
}
