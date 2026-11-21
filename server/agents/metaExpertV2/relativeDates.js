// Meta Ads Expert V2 — Phase 2 (daily check-in): relative dates, resolved
// server-side, never guessed by the model.
//
// The live Test 2 failure (Nov 21 2026): the user said "Oct 3 to Oct 9"
// with no year, the model guessed a year, and Meta rejected the call with
// (#3018) "the start date of the time range cannot be beyond 37 months" —
// Oct 3 2023 is ~37 months before Nov 2026, so a guessed 2023 year lands
// exactly on Meta's limit. Nothing in this module ever guesses a year:
// every phrase is anchored to the real current date, in the user's own
// timezone (Asia/Karachi), and the year always comes from that date.
//
// Pure functions only — no Meta calls, no DB, no model input beyond the
// phrase itself — so they are trivially unit-testable and can never send
// a wrong date to Meta: the check-in tool has no date parameters at all,
// it calls these with `new Date()` itself.

export const CHECKIN_TIMEZONE = "Asia/Karachi";

// Calendar date (year/month/day) of an instant, in the given timezone.
// Intl with timeZone is the only timezone math here — no date library in
// this codebase, and hand-rolled UTC-offset arithmetic would be wrong
// twice a year if Pakistan ever reintroduced DST (it has before).
export function partsInTimezone(date, timeZone = CHECKIN_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function ymdFromParts({ year, month, day }) {
  const p = (n) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)}`;
}

// "Today" as a YYYY-MM-DD calendar date in the user's timezone.
export function todayYmd(now = new Date(), timeZone = CHECKIN_TIMEZONE) {
  return ymdFromParts(partsInTimezone(now, timeZone));
}

// Date arithmetic on plain YYYY-MM-DD calendar dates (UTC midnight, so
// no timezone or DST edge can shift the result by a day).
export function addDaysYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function spanDays(since, until) {
  return Math.round((new Date(`${until}T00:00:00Z`) - new Date(`${since}T00:00:00Z`)) / 86400000) + 1;
}

// The check-in's own windows, always computed from the real current date:
// yesterday is a single day; the main window is the 7 days ending
// yesterday (Meta's "last 7 days" never includes the partial today); the
// prior window is the 7 days before that, for the comparison. Today is
// its own window too — round 68: the check-in must fetch TODAY's rows,
// not only up to yesterday. A campaign that started yesterday and is
// spending today is invisible to every window above, and live, Nov 21
// 2026, that is exactly what happened (PKR 623 spent Nov 21, the
// check-in said "no activity in the last 7 days").
export function resolveCheckinWindows(now = new Date(), timeZone = CHECKIN_TIMEZONE) {
  const today = todayYmd(now, timeZone);
  const yesterday = addDaysYmd(today, -1);
  return {
    today,
    todayWindow: { since: today, until: today },
    yesterday: { since: yesterday, until: yesterday },
    last7Days: { since: addDaysYmd(today, -7), until: yesterday },
    prior7Days: { since: addDaysYmd(today, -14), until: addDaysYmd(today, -8) },
  };
}

// The 7-day slices going back from a given day, for the recent-activity
// scan: slice 0 is the 7 days ending yesterday, slice 1 the 7 days
// before that, and so on. Each slice is exactly 7 calendar days, so a
// slice's totals are real totals for those exact dates — never a window
// guessed from a probe's date bounds.
export function weeklySlicesBackFrom(today, maxSlices = 13) {
  const slices = [];
  for (let k = 0; k < maxSlices; k += 1) {
    slices.push({ since: addDaysYmd(today, -7 * (k + 1)), until: addDaysYmd(today, -7 * k - 1) });
  }
  return slices;
}

// Human dates for the report, with the year always shown — "14 Nov to
// 20 Nov 2026", or "20 Nov 2026" for a single day. A date without a year
// is exactly how the live #3018 failure started.
export function formatYmdHuman(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

export function formatRangeHuman(since, until) {
  if (!since || !until) return null;
  if (since === until) return formatYmdHuman(since);
  return `${formatYmdHuman(since).replace(/ \d{4}$/, "")} to ${formatYmdHuman(until)}`;
}

// Resolves a vague period phrase to explicit dates, anchored to the real
// current date — the year always comes from `now`, never from the phrase.
// Returns { since, until, label, recognized }. An unrecognized phrase is
// NOT an error: it falls back to the last 7 days and says so, so a typo
// can never break the whole check-in (the fallback is reported in the
// result, never silent).
export function resolveRelativeDatePhrase(phrase, now = new Date(), timeZone = CHECKIN_TIMEZONE) {
  const today = todayYmd(now, timeZone);
  const yesterday = addDaysYmd(today, -1);
  const p = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const { year, month } = partsInTimezone(now, timeZone);

  switch (p) {
    case "today":
      return { since: today, until: today, label: `today (${formatYmdHuman(today)})`, recognized: true };
    case "yesterday":
      return { since: yesterday, until: yesterday, label: `yesterday (${formatYmdHuman(yesterday)})`, recognized: true };
    case "last 7 days":
    case "last week":
    case "past week":
    case "past 7 days":
      return { since: addDaysYmd(today, -7), until: yesterday, label: `the last 7 days (${formatRangeHuman(addDaysYmd(today, -7), yesterday)})`, recognized: true };
    case "last 30 days":
    case "past 30 days":
    case "last month (30 days)":
      return { since: addDaysYmd(today, -30), until: yesterday, label: `the last 30 days (${formatRangeHuman(addDaysYmd(today, -30), yesterday)})`, recognized: true };
    case "this week": {
      // Monday of the current week through yesterday (ISO weeks start Monday).
      const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
      const daysSinceMonday = (dow + 6) % 7;
      const monday = addDaysYmd(today, -daysSinceMonday);
      return { since: monday, until: yesterday, label: `this week (${formatRangeHuman(monday, yesterday)})`, recognized: true };
    }
    case "this month": {
      const first = ymdFromParts({ year, month, day: 1 });
      return { since: first, until: yesterday, label: `this month (${formatRangeHuman(first, yesterday)})`, recognized: true };
    }
    case "last month": {
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      const first = ymdFromParts({ year: prevYear, month: prevMonth, day: 1 });
      const last = ymdFromParts({ year: prevYear, month: prevMonth, day: daysInMonth(prevYear, prevMonth) });
      return { since: first, until: last, label: `last month (${formatRangeHuman(first, last)})`, recognized: true };
    }
    default:
      return {
        since: addDaysYmd(today, -7),
        until: yesterday,
        label: `the last 7 days (${formatRangeHuman(addDaysYmd(today, -7), yesterday)})`,
        recognized: false,
        fallbackNote: `I did not recognise "${phrase}" as a period, so I used the last 7 days.`,
      };
  }
}

// Plain percent change between two real totals — null on a zero base
// (never Infinity: "up from 0 orders" has no honest percentage), null
// when either side is missing. Same rule as performanceBreakdown.js's
// percentChange, kept local here so this module stays dependency-free.
export function pctChange(current, prior) {
  if (current == null || prior == null) return null;
  if (prior === 0) return current === 0 ? 0 : null;
  return ((current - prior) / prior) * 100;
}

export function spanDaysBetween(since, until) {
  return spanDays(since, until);
}
