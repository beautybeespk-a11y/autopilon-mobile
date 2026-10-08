// Meta Ads Expert V2 — Phase 3A: granular performance reads.
//
// get_business_snapshot (businessSnapshot.js) gives an account-level
// rollup — enough to decide a NEW campaign's strategy, but not enough to
// answer "how is campaign X doing," "which ad set is spending the most,"
// or "how did last week compare to the week before." This module answers
// those, for ONE specific campaign, broken down by ad set and ad.
//
// Scope for 3A, deliberately: reading and presenting only. No diagnosis,
// no recommendations, no actions (that's 3B/3C). The two sorted "top by
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
import * as meta from "../../integrations/meta/api.js";

export const DEFAULT_DATE_PRESET = "last_7d";

// Deliberately a LOCAL copy, not an import of businessSnapshot.js's own
// blendedRate — this round is additive only and doesn't touch round 49's
// code. Extended with a numerator-null guard round 49's version never
// needed: its numerator is always a real SUMMED number (via Number(x)||0
// across every campaign), never null, so that case was unreachable there.
// THIS file's numerators are a single ad set/ad's own purchases/revenue,
// which can genuinely be null — no purchase action recorded at all for
// that entity in the range (confirmed live: Meta omits the action type
// entirely rather than reporting a zero) — and null/denominator must
// never silently read as a real zero rate.
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

// spend/clicks/impressions/reach are always real numbers on a returned
// row (Meta never omits these); purchases/revenue can genuinely be null
// (extractActionValue, api.js) — kept as null here rather than coerced to
// 0, so ratesFromTotals' numerator-null guard above actually gets to see it.
function totalsFromRow(row) {
  return {
    spend: Number(row.spend) || 0,
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    purchases: row.purchases ?? null,
    revenue: row.revenue ?? null,
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

// Plain sorts of real numbers for "which ad set/ad is spending the most /
// converting worst" — scoped to entities that actually had activity in
// the range (sorting a no-activity entity in here would be presenting a
// fact Meta never reported). Never a recommendation — that's 3B/3C.
function topBySpend(entities, n = 3) {
  return [...entities].sort((a, b) => b.totals.spend - a.totals.spend).slice(0, n).map((e) => ({ id: e.id, name: e.name, spend: e.totals.spend }));
}
function worstByCpa(entities, n = 3) {
  return entities.filter((e) => e.rates.cpa != null).sort((a, b) => b.rates.cpa - a.rates.cpa).slice(0, n).map((e) => ({ id: e.id, name: e.name, cpa: e.rates.cpa }));
}

export async function gatherPerformanceBreakdown(accessToken, { campaignId, datePreset, since, until, compareToPriorPeriod } = {}) {
  if (!campaignId) {
    const err = new Error("campaignId is required — Phase 3A reads one specific campaign's ad sets and ads; an account-wide, multi-campaign breakdown isn't built yet.");
    err.code = "META_V2_CAMPAIGN_ID_REQUIRED";
    throw err;
  }

  const dateParams = resolveDateParams({ datePreset, since, until });
  const campaign = await meta.getCampaign(accessToken, campaignId);

  const [campaignRows, adSetRows, adRows, fullAdSetRoster, fullAdRoster] = await Promise.all([
    meta.getCampaignLevelInsights(accessToken, campaignId, dateParams),
    meta.getAdSetLevelInsights(accessToken, campaignId, dateParams),
    meta.getAdLevelInsights(accessToken, campaignId, dateParams),
    meta.listAdSets(accessToken, campaign.account_id),
    meta.listAds(accessToken, campaign.account_id),
  ]);

  const campaignRow = campaignRows[0] || null;
  const campaignSummary = campaignRow
    ? { ...entityFromRow(campaignRow, "campaign_id", "campaign_name"), id: campaign.id, name: campaign.name, noActivityInRange: false }
    : { id: campaign.id, name: campaign.name, totals: null, rates: null, dateStart: null, dateStop: null, noActivityInRange: true };

  // The real, complete roster (round 50's listAdSets/listAds, now with
  // their first caller) filtered to THIS campaign — cross-referenced
  // against which ones actually had an insights row, so a paused/
  // inactive ad set or ad is reported as "no activity in this range,"
  // never silently omitted and never implied to have spent zero.
  const adSetsUnderCampaign = fullAdSetRoster.filter((a) => a.campaign_id === campaignId);
  const adsUnderCampaign = fullAdRoster.filter((a) => a.campaign_id === campaignId);

  const adSetsWithActivity = adSetRows.map((row) => {
    const roster = adSetsUnderCampaign.find((a) => a.id === row.adset_id);
    return { ...entityFromRow(row, "adset_id", "adset_name"), status: roster?.status ?? null, noActivityInRange: false };
  });
  const activeAdSetIds = new Set(adSetsWithActivity.map((a) => a.id));
  const adSetsWithNoActivity = adSetsUnderCampaign
    .filter((a) => !activeAdSetIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, status: a.status, totals: null, rates: null, noActivityInRange: true }));

  const adsWithActivity = adRows.map((row) => {
    const roster = adsUnderCampaign.find((a) => a.id === row.ad_id);
    return { ...entityFromRow(row, "ad_id", "ad_name"), status: roster?.status ?? null, noActivityInRange: false };
  });
  const activeAdIds = new Set(adsWithActivity.map((a) => a.id));
  const adsWithNoActivity = adsUnderCampaign
    .filter((a) => !activeAdIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, status: a.status, totals: null, rates: null, noActivityInRange: true }));

  let comparison = null;
  if (compareToPriorPeriod) {
    if (campaignSummary.dateStart && campaignSummary.dateStop) {
      const prior = priorPeriod(campaignSummary.dateStart, campaignSummary.dateStop);
      const priorRows = await meta.getCampaignLevelInsights(accessToken, campaignId, prior);
      const priorRow = priorRows[0] || null;
      const priorTotals = priorRow ? totalsFromRow(priorRow) : null;
      const priorRates = priorTotals ? ratesFromTotals(priorTotals) : null;
      comparison = {
        currentRange: { since: campaignSummary.dateStart, until: campaignSummary.dateStop },
        priorRange: prior,
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
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, objective: campaign.objective },
    dateRange: { requested: dateParams, resolvedSince: campaignSummary.dateStart, resolvedUntil: campaignSummary.dateStop },
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
