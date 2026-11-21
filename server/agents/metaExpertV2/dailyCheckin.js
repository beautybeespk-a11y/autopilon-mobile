// Meta Ads Expert V2 — Phase 2 (daily check-in, roadmap p.3).
//
// Every morning, the agent looks at what is running and gives a short
// summary: what is working, what is dying, and what needs attention
// today. Spend, orders and cost per order in plain words, the best and
// worst ad sets named, and one clear "today I recommend..." line.
//
// What this module is — and is not:
//   * READ-ONLY. It calls list/get/insights endpoints only. It never
//     creates, pauses, resumes, or changes the budget of anything, and
//     it creates no strategy rows. The "no mutate calls" test proves it.
//   * The numbers are the account's OWN numbers, fetched live from Meta
//     for explicit calendar dates the server computes itself (relative-
//     Dates.js, Asia/Karachi) — never a date the model guessed, never a
//     cached or stale number, never an invented benchmark. A rate is
//     always blended from summed totals (round 49's rule), never an
//     average of per-ad-set rates.
//   * The recommendation is ONE line of WORDS. It never acts. If it
//     says a fix is worth proposing, the user still has to ask for it
//     and approve it — Phases 3+ own the actual fix proposals.
//
// How the periods work (all explicit dates, always shown with the year):
//   * Yesterday — a single day. Last 7 days — the 7 days ending
//     yesterday (Meta's "last 7 days" never includes the partial today).
//     Prior 7 days — the 7 days before that, for the comparison.
//   * If the main window had no activity, the report says so plainly
//     and then scans back in 7-day slices (at most ~90 days) for the
//     most recent week WITH activity, and reports THAT window's real
//     numbers — labelled "most recent activity", never presented as
//     yesterday's or this week's numbers.
//   * Scope: the whole ad account by default (every campaign's ad sets,
//     each attributed to its real campaign). Pass campaignName to scope
//     to one campaign — resolved deterministically, paused campaigns
//     included, exactly like get_performance_breakdown.
//
// Morning delivery (NOT built here — named as the follow-up, not faked):
// the app already has a scheduler (automation/scheduler.js, node-cron,
// daily at 9am by default) and an automation engine, but automation
// steps cannot message the user in chat — there is no "send a chat
// message" step type (condition/action/ai_decision/approval/delay/loop
// /end only), and no built-in per-user scheduled agent run. So a real
// morning push needs a new delivery path plus the user's opt-in, which
// is a separate decision — this PR ships the report itself, askable in
// chat ("daily check-in"), which is what the roadmap's Done-when can
// actually verify today.
import * as meta from "../../integrations/meta/api.js";
import { resolveAdAccountId } from "../../tools/shared/metaAdAccountId.js";
import { getConnection } from "../../integrations/manager.js";
import { checkAccountHealthCached } from "./accountHealth.js";
import { ratesFromTotals, topBySpend, worstByCpa, resolveCampaignByName } from "./performanceBreakdown.js";
import {
  CHECKIN_TIMEZONE,
  resolveCheckinWindows,
  resolveRelativeDatePhrase,
  weeklySlicesBackFrom,
  formatRangeHuman,
  formatYmdHuman,
  pctChange,
  addDaysYmd,
} from "./relativeDates.js";
import { logger } from "../../config/logger.js";

const MAX_SCAN_SLICES = 13; // ~91 days back — same bound as the 90-day activity probe in performanceBreakdown.js
const ZERO_CONVERSION_CLICKS_THRESHOLD = 50; // same sample-size rule as performanceBreakdown.js 3B: zero purchases across 50 real clicks is a pattern worth naming, not bad luck
const BEST_WORST_CPA_RATIO = 1.25; // best must be at least 20% cheaper than worst to be worth naming (same margin family as 3B's 1.2x)

function formatMoney(amount, currency) {
  if (amount == null) return null;
  const num = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${num}` : num;
}

function formatNumber(n) {
  if (n == null) return null;
  return Number(n).toLocaleString("en-US");
}

// One ad-set insights row (Meta's own shape, purchases/revenue already
// extracted by api.js) into the entity shape performanceBreakdown.js's
// sort helpers expect — totals summed, rates blended from those totals.
function entityFromInsightRow(row) {
  const totals = {
    spend: Number(row.spend) || 0,
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    purchases: row.purchases ?? 0,
    revenue: row.revenue ?? 0,
  };
  return {
    id: row.adset_id,
    name: row.adset_name,
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || null,
    totals,
    rates: ratesFromTotals(totals),
  };
}

function summarizeEntities(entities) {
  if (!entities.length) return null;
  const totals = entities.reduce(
    (acc, e) => {
      acc.spend += e.totals.spend;
      acc.clicks += e.totals.clicks;
      acc.impressions += e.totals.impressions;
      acc.reach += e.totals.reach;
      acc.purchases += e.totals.purchases;
      acc.revenue += e.totals.revenue;
      return acc;
    },
    { spend: 0, clicks: 0, impressions: 0, reach: 0, purchases: 0, revenue: 0 }
  );
  return { totals, rates: ratesFromTotals(totals) };
}

function bestByCpa(entities) {
  const withCpa = entities.filter((e) => e.rates.cpa != null).sort((a, b) => a.rates.cpa - b.rates.cpa || b.totals.purchases - a.totals.purchases);
  return withCpa[0] || null;
}

// Full-entity worst, for the report and the recommendation: the
// imported worstByCpa returns the breakdown's MAPPED shape ({id, name,
// spend} — no totals/rates), which is what the structured result
// carries for consistency, but rendering needs the real entity.
function worstByCpaEntity(entities) {
  const withCpa = entities.filter((e) => e.rates.cpa != null).sort((a, b) => b.rates.cpa - a.rates.cpa || b.totals.purchases - a.totals.purchases);
  return withCpa[0] || null;
}

function summarizePeriod(rows, { since, until }) {
  const entities = (rows || []).map(entityFromInsightRow);
  const summary = summarizeEntities(entities);
  // "Activity" means REAL activity — money moved (spend > 0) or real
  // orders happened (purchases > 0). A row merely EXISTING does not
  // count. Live failure, Nov 21 2026: Meta returned rows for a
  // mid-October week with zero spend, and the old `entities.length > 0`
  // rule reported that dead week as the "most recent activity" ("16 to
  // 22 October 2026, where there was also zero spend") instead of
  // scanning on to Oct 3–9, where the real spend was (PKR 4,660.42, 8
  // orders). A zero-spend, zero-order week is silence, not activity —
  // it must be skipped by the scan and rendered as "no activity", never
  // reported as a measured result. Clicks or impressions alone do not
  // count either: clicks without spend or orders are not a week of ads
  // running, they are a row Meta returned for an ad set that did not
  // deliver.
  const hasActivity = summary ? summary.totals.spend > 0 || summary.totals.purchases > 0 : false;
  return {
    since,
    until,
    label: formatRangeHuman(since, until),
    hasActivity,
    totals: summary ? summary.totals : null,
    rates: summary ? summary.rates : null,
    adSets: entities,
    topAdSetsBySpend: topBySpend(entities),
    worstAdSetsByCpa: worstByCpa(entities),
    bestAdSetByCpa: bestByCpa(entities),
    worstAdSetByCpa: worstByCpaEntity(entities),
  };
}

// Saved defaults are read from the Meta connection's own meta.defaults
// (the same source businessSnapshot.js reads) — never invented. A saved
// id only counts if it is still in the live list; otherwise the single
// connected item counts; otherwise null, and the health check simply
// skips that sub-check (its own fail-open rule).
function readSavedDefaults(userId) {
  try {
    const conn = getConnection(userId, "meta_ads");
    return JSON.parse(conn?.meta || "{}").defaults || {};
  } catch {
    return {};
  }
}

function pickDefault(items, savedId) {
  if (savedId && (items || []).some((i) => String(i.id) === String(savedId))) return String(savedId);
  if ((items || []).length === 1) return String(items[0].id);
  return null;
}

async function resolveHealthAssets(accessToken, adAccountId, userId) {
  const defaults = readSavedDefaults(userId);
  let pageId = null;
  let pixelId = null;
  try {
    pageId = pickDefault(await meta.listPages(accessToken), defaults.pageId);
  } catch (err) {
    logger.warn("meta_expert_v2.daily_checkin.page_list_open", { adAccountId, error: String(err?.message || err) });
  }
  try {
    pixelId = pickDefault(await meta.listPixels(accessToken, adAccountId), defaults.pixelId);
  } catch (err) {
    logger.warn("meta_expert_v2.daily_checkin.pixel_list_open", { adAccountId, error: String(err?.message || err) });
  }
  return { pageId, pixelId };
}

// ONE recommendation line, deterministic, always naming the number it
// rests on. Priority order is deliberate: a broken account outranks
// everything (no point judging performance on an account that cannot
// run), then a real zero-conversion pattern, then a genuine efficiency
// gap, then "no change". It is WORDS ONLY — no pause, no budget change,
// no action of any kind is taken or promised as if it will happen on
// its own; a fix is always "tell me and I will propose it".
//
// It takes RAW numbers and formats them itself, inside this function:
// the best-vs-worst comparison is arithmetic on real CPAs, so the
// inputs must never be pre-formatted money strings (formatting first
// would make the ratio NaN and silently disable the rule).
export function buildCheckinRecommendation({ health, main, recentActivity, today, currency }) {
  if (health && !health.ok && health.issues && health.issues.length) {
    return `Today I recommend fixing this first: ${health.issues[0].message} Until that is fixed, new campaigns cannot run reliably.`;
  }
  if (main && main.hasActivity) {
    const zeroConv = (main.adSets || [])
      .filter((e) => e.totals.purchases === 0 && e.totals.clicks >= ZERO_CONVERSION_CLICKS_THRESHOLD)
      .sort((a, b) => b.totals.clicks - a.totals.clicks)[0];
    if (zeroConv) {
      return `Today I recommend we look at ${zeroConv.name} — it spent ${formatMoney(zeroConv.totals.spend, currency)} on ${formatNumber(zeroConv.totals.clicks)} clicks with 0 orders. Tell me and I will propose a fix for your approval.`;
    }
    const best = main.bestAdSetByCpa;
    const worst = main.worstAdSetByCpa;
    if (best && worst && best.id !== worst.id && best.rates.cpa * BEST_WORST_CPA_RATIO <= worst.rates.cpa) {
      return `Today I recommend keeping the budget where it is and watching ${best.name} — it is your cheapest orders at ${formatMoney(best.rates.cpa, currency)} per order on ${formatNumber(best.totals.purchases)} orders, while ${worst.name} costs ${formatMoney(worst.rates.cpa, currency)} per order. No change needed today.`;
    }
    return `Today I recommend no change — ${formatMoney(main.totals.spend, currency)} spent for ${formatNumber(main.totals.purchases)} orders in ${main.label}. Re-check tomorrow.`;
  }
  // Round 68 — the main window is dead, so today is the freshest
  // signal: a campaign that started yesterday and is spending TODAY is
  // judged on today's numbers, never on the silent week. The
  // zero-conversion rule applies to today exactly as it does to the
  // main window (50+ clicks, 0 orders names the ad set).
  if (today && today.hasActivity) {
    const zeroConv = (today.adSets || [])
      .filter((e) => e.totals.purchases === 0 && e.totals.clicks >= ZERO_CONVERSION_CLICKS_THRESHOLD)
      .sort((a, b) => b.totals.clicks - a.totals.clicks)[0];
    if (zeroConv) {
      return `Today I recommend we look at ${zeroConv.name} — it spent ${formatMoney(zeroConv.totals.spend, currency)} on ${formatNumber(zeroConv.totals.clicks)} clicks with 0 orders today so far. Tell me and I will propose a fix for your approval.`;
    }
    return `Today I recommend no change — ${formatMoney(today.totals.spend, currency)} spent for ${formatNumber(today.totals.purchases)} orders today so far. Re-check tomorrow.`;
  }
  if (recentActivity) {
    return `Today I recommend no change — nothing ran in ${main.label}. Your most recent activity was ${recentActivity.label}: ${formatMoney(recentActivity.totals.spend, currency)} spent for ${formatNumber(recentActivity.totals.purchases)} orders. If you want to run ads again, tell me which campaign and I will propose it for your approval.`;
  }
  return "Today I recommend no change — no ads have run in the last 90 days. If you want sales again, tell me which campaign to start and I will propose it for your approval.";
}

// Plain-language rendering of one period's totals — numbers only, no
// verdicts. A period with no activity says exactly that; it never
// reports zero spend as if it were a measured result.
function renderPeriodLines(period, currency, title) {
  const lines = [`${title} (${period.label}):`];
  if (!period.hasActivity) {
    lines.push("No activity — no spend, no orders.");
    return lines;
  }
  const t = period.totals;
  const r = period.rates;
  // Round 68 — reach and impressions ride on the same line: the live
  // check-in had to show the Nov 20-21 spend WITH its reach/impressions,
  // and the sentence is appended after the CPA clause so every earlier
  // exact-match assertion on the spend/orders/revenue part still holds.
  lines.push(`Spend ${formatMoney(t.spend, currency)}, ${formatNumber(t.purchases)} orders, revenue ${formatMoney(t.revenue, currency)}, ROAS ${r.roas == null ? "not available (no spend)" : r.roas.toFixed(2)}, cost per order ${r.cpa == null ? "not available (no orders)" : `${formatMoney(r.cpa, currency)} per order`}. Reach ${formatNumber(t.reach)}, impressions ${formatNumber(t.impressions)}.`);
  return lines;
}

function renderAdSetLine(entity, currency) {
  const t = entity.totals;
  const r = entity.rates;
  const where = entity.campaignName ? ` (${entity.campaignName})` : "";
  return `${entity.name}${where}: spend ${formatMoney(t.spend, currency)}, ${formatNumber(t.purchases)} orders, cost per order ${r.cpa == null ? "not available (no orders)" : `${formatMoney(r.cpa, currency)} per order`}.`;
}

// The report text itself — plain language, no markdown (no **bold**, no
// ## headings, no backticks, no links), explicit dates with the year,
// real currency labels. The tool description tells the model to present
// this text exactly as returned, never re-derived or reworded — the
// numbers here are the ones that were verified against Meta, and a
// model paraphrase is how a correct number has gone wrong before.
export function renderDailyCheckinReport(checkin) {
  const { currency, health } = checkin;
  const lines = [`Daily check-in — ${formatYmdHuman(checkin.generatedOn)} (${CHECKIN_TIMEZONE})`];
  if (checkin.scopeLabel) lines.push(`Scope: ${checkin.scopeLabel}.`);
  if (health) {
    if (health.ok) lines.push("Account health: All healthy — ad account active, permissions granted.");
    else lines.push(`Account health: WARNING — ${health.issues.map((i) => i.message).join(" ")}`);
  }
  // Round 68 — today first: the freshest numbers lead the report. A
  // campaign spending today is shown here with its spend, reach and
  // impressions, even when yesterday and the last 7 days are silent.
  // The section only renders when today actually has activity, so a
  // quiet day changes nothing about the report below it.
  if (checkin.today?.hasActivity) {
    lines.push(...renderPeriodLines(checkin.today, currency, "Today so far"));
    const todayTop = [...(checkin.today.adSets || [])].sort((a, b) => b.totals.spend - a.totals.spend)[0];
    if (todayTop && todayTop.totals.spend > 0) {
      lines.push(`Spending today: ${renderAdSetLine(todayTop, currency)}`);
    }
  }
  lines.push(...renderPeriodLines(checkin.yesterday, currency, "Yesterday"));
  lines.push(...renderPeriodLines(checkin.main, currency, checkin.mainTitle));
  // Prior-period comparison — only when both sides have real activity;
  // a zero base has no honest percentage, so it is stated, never invented.
  if (checkin.main.hasActivity && checkin.prior.hasActivity) {
    const spendPct = pctChange(checkin.main.totals.spend, checkin.prior.totals.spend);
    const ordersPct = pctChange(checkin.main.totals.purchases, checkin.prior.totals.purchases);
    const spendBit = spendPct == null ? "spend changed from 0" : `spend ${spendPct >= 0 ? "up" : "down"} ${Math.abs(spendPct).toFixed(1)}%`;
    const ordersBit = ordersPct == null ? "orders changed from 0" : `orders ${ordersPct >= 0 ? "up" : "down"} ${Math.abs(ordersPct).toFixed(1)}%`;
    lines.push(`Compared with the 7 days before that (${checkin.prior.label}): ${spendBit} (was ${formatMoney(checkin.prior.totals.spend, currency)}), ${ordersBit} (was ${formatNumber(checkin.prior.totals.purchases)}).`);
  } else if (checkin.main.hasActivity) {
    lines.push(`The 7 days before that (${checkin.prior.label}) had no activity, so there is no prior period to compare against.`);
  }
  // Best / worst — named, with their numbers. A single ad set with
  // orders is named as the only one, never dressed up as a best-vs-worst
  // contrast; no orders anywhere means no best or worst exists to name.
  const best = checkin.main.bestAdSetByCpa;
  const worst = checkin.main.worstAdSetByCpa;
  if (checkin.main.hasActivity) {
    if (best && worst && best.id !== worst.id) {
      lines.push(`Best ad set by cost per order: ${renderAdSetLine(best, currency)}`);
      lines.push(`Worst ad set by cost per order: ${renderAdSetLine(worst, currency)}`);
    } else if (best) {
      lines.push(`Only one ad set had orders: ${renderAdSetLine(best, currency)}`);
    } else {
      lines.push("No ad set had any orders in this period, so there is no best or worst ad set by cost per order to name.");
    }
  }
  if (!checkin.main.hasActivity && checkin.recentActivity) {
    const ra = checkin.recentActivity;
    // Round 68 — when today has activity, today IS the most recent
    // activity, so the older week is "previous activity", never "most
    // recent". The title passed to renderPeriodLines changes with the
    // heading, so no "Most recent activity (3 Oct…" line can leak into
    // a report whose most recent activity is today.
    const raTitle = checkin.today?.hasActivity ? "Previous activity" : "Most recent activity";
    lines.push(`${raTitle} (${ra.label}) — ${checkin.today?.hasActivity ? "the most recent week with activity before today, for reference:" : "this is the most recent week with activity, not yesterday and not the last 7 days:"}`);
    lines.push(...renderPeriodLines(ra, currency, raTitle));
    const raBest = ra.bestAdSetByCpa;
    const raWorst = ra.worstAdSetByCpa;
    if (raBest && raWorst && raBest.id !== raWorst.id) {
      lines.push(`Best ad set by cost per order in that week: ${renderAdSetLine(raBest, currency)}`);
      lines.push(`Worst ad set by cost per order in that week: ${renderAdSetLine(raWorst, currency)}`);
    } else if (raBest) {
      lines.push(`Only one ad set had orders that week: ${renderAdSetLine(raBest, currency)}`);
    }
  }
  // Round 68 — "no ads in 90 days" is only honest when TODAY is silent
  // too: a campaign spending today has run in the last 90 days, and the
  // line must never contradict the Today section above it.
  if (!checkin.main.hasActivity && !checkin.recentActivity && !checkin.today?.hasActivity) {
    lines.push("No ads have run in the last 90 days.");
  }
  lines.push(`Today I recommend: ${checkin.recommendation}`);
  return lines.join("\n");
}

export async function gatherDailyCheckin(accessToken, { userId, campaignName, period, now = new Date() } = {}) {
  const windows = resolveCheckinWindows(now, CHECKIN_TIMEZONE);
  const mainResolution = period
    ? resolveRelativeDatePhrase(period, now, CHECKIN_TIMEZONE)
    : { since: windows.last7Days.since, until: windows.last7Days.until, label: `the last 7 days (${formatRangeHuman(windows.last7Days.since, windows.last7Days.until)})`, recognized: true };
  const mainWindow = { since: mainResolution.since, until: mainResolution.until };
  // The prior window is the equal-length window immediately before the
  // main one — same rule as performanceBreakdown.js's priorPeriod.
  const spanDays = Math.round((new Date(mainWindow.until) - new Date(mainWindow.since)) / 86400000);
  const priorWindow = { since: addDaysYmd(mainWindow.since, -(spanDays + 1)), until: addDaysYmd(mainWindow.since, -1) };
  const mainWindowValid = mainWindow.since <= mainWindow.until;

  const adAccountId = await resolveAdAccountId({ userId, accessToken, providedAdAccountId: undefined });
  let currency = null;
  try {
    const account = await meta.getAdAccount(accessToken, adAccountId);
    currency = account?.currency || null;
  } catch (err) {
    logger.warn("meta_expert_v2.daily_checkin.currency_open", { adAccountId, error: String(err?.message || err) });
  }
  let campaigns = [];
  try {
    campaigns = (await meta.listCampaigns(accessToken, adAccountId)) || [];
  } catch (err) {
    logger.warn("meta_expert_v2.daily_checkin.campaigns_open", { adAccountId, error: String(err?.message || err) });
  }

  // Scope: one named campaign, or the whole ad account. The fetch
  // function is the only thing that differs — the same shaping, totals,
  // and best/worst rules apply to both, so a scoped report and an
  // account-wide report can never disagree about what a number means.
  let fetchRows;
  let scopeLabel;
  let campaign = null;
  if (campaignName) {
    campaign = await resolveCampaignByName(accessToken, { userId, campaignName });
    fetchRows = (since, until) => meta.getAdSetLevelInsights(accessToken, campaign.id, { since, until });
    scopeLabel = campaign.name;
  } else {
    fetchRows = (since, until) => meta.getAccountAdSetLevelInsights(accessToken, adAccountId, { since, until });
    scopeLabel = "your whole ad account";
  }

  const emptySummary = (since, until) => ({
    since, until, label: formatRangeHuman(since, until),
    hasActivity: false, totals: null, rates: null, adSets: [], topAdSetsBySpend: [], worstAdSetsByCpa: [], bestAdSetByCpa: null, worstAdSetByCpa: null,
  });

  // Yesterday, main window, prior window, and TODAY — fetched in
  // parallel; a single failed insights call fails the whole check-in
  // loudly rather than returning a partial report that looks complete.
  // Round 68: today is fetched here, in the same parallel batch. The
  // main window ends at yesterday by design (Meta's "last 7 days"
  // never includes the partial today), so without this call a campaign
  // that started yesterday and is spending today is invisible to the
  // whole report — live, Nov 21 2026, PKR 623 spent today was reported
  // as "no activity in the last 7 days".
  const [yesterdayRows, mainRows, priorRows, todayRows] = await Promise.all([
    fetchRows(windows.yesterday.since, windows.yesterday.until),
    mainWindowValid ? fetchRows(mainWindow.since, mainWindow.until) : Promise.resolve([]),
    fetchRows(priorWindow.since, priorWindow.until),
    fetchRows(windows.todayWindow.since, windows.todayWindow.until),
  ]);
  const yesterday = summarizePeriod(yesterdayRows, windows.yesterday);
  const main = mainWindowValid
    ? summarizePeriod(mainRows, mainWindow)
    : { ...emptySummary(mainWindow.since, mainWindow.until), label: mainResolution.label, note: "This period has not started yet." };
  const prior = summarizePeriod(priorRows, priorWindow);
  const today = summarizePeriod(todayRows, windows.todayWindow);

  // No activity in the main window (and none in the prior window either
  // — otherwise the prior window IS the recent activity): scan back in
  // 7-day slices from just before the main window, stopping at the first
  // slice with real activity. Slices already fetched are never re-fetched.
  let recentActivity = null;
  if (!main.hasActivity && !prior.hasActivity) {
    const fetchedKeys = new Set([
      `${mainWindow.since}|${mainWindow.until}`,
      `${priorWindow.since}|${priorWindow.until}`,
      `${windows.yesterday.since}|${windows.yesterday.until}`,
      // Round 68 — today is already fetched above; the scan must never
      // re-fetch it, and must never mistake today for a scanned week.
      `${windows.todayWindow.since}|${windows.todayWindow.until}`,
    ]);
    const slices = weeklySlicesBackFrom(mainWindow.since, MAX_SCAN_SLICES);
    for (const slice of slices) {
      const key = `${slice.since}|${slice.until}`;
      if (fetchedKeys.has(key)) continue;
      fetchedKeys.add(key);
      const rows = await fetchRows(slice.since, slice.until);
      // Only a slice with REAL activity counts — summarize first, then
      // ask the summary. The old code stopped at the first slice that
      // returned ANY rows, and live Meta does return rows for weeks with
      // zero spend (Nov 21 2026: a dead mid-October week stopped the
      // scan, so Oct 3–9 was never reached). A zero-spend slice is
      // skipped here, never reported as "most recent activity".
      const summary = summarizePeriod(rows, slice);
      if (summary.hasActivity) {
        recentActivity = summary;
        break;
      }
    }
  } else if (!main.hasActivity && prior.hasActivity) {
    // The prior window itself is the most recent activity — report it as
    // such instead of scanning further back for an older week.
    recentActivity = { ...prior, label: formatRangeHuman(prior.since, prior.until) };
  }

  // Account health (Phase 1) — ad account status, billing, scopes, Page
  // link, Pixel. Fails open inside checkAccountHealth itself on transient
  // errors, so a flaky Meta call can never block the whole report; a
  // PROVEN problem (disabled account, missing scope) is reported at the
  // top of the report instead.
  const { pageId, pixelId } = await resolveHealthAssets(accessToken, adAccountId, userId);
  let health = null;
  try {
    health = await checkAccountHealthCached({ userId, accessToken, adAccountId, pageId, pixelId });
  } catch (err) {
    logger.warn("meta_expert_v2.daily_checkin.health_open", { adAccountId, error: String(err?.message || err) });
  }

  const mainTitle = mainResolution.recognized === false
    ? `Main period (${mainResolution.label})`
    : (period ? `Main period (${mainResolution.label})` : "Last 7 days");

  const checkin = {
    scope: campaign ? { type: "campaign", id: campaign.id, name: campaign.name } : { type: "account_wide", adAccountId },
    scopeLabel,
    currency,
    timezone: CHECKIN_TIMEZONE,
    generatedOn: windows.today,
    yesterday,
    today,
    main: { ...main, title: mainTitle },
    mainTitle,
    prior,
    recentActivity,
    health,
    periodNote: mainResolution.fallbackNote || null,
    campaignsKnown: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    recommendation: null,
    reportText: null,
  };
  // The recommendation reads the SAME summaries the report renders —
  // it can never rest on a number the report does not show. Raw numbers
  // go in; the builder formats them itself (see its note).
  checkin.recommendation = buildCheckinRecommendation({ health, main, recentActivity, today, currency });
  checkin.reportText = renderDailyCheckinReport(checkin);
  return checkin;
}
