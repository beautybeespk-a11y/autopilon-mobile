// Google PageSpeed Insights (Lighthouse) API v5 — free. Works without an API
// key at Google's shared, low, unauthenticated quota; setting
// GOOGLE_PAGESPEED_API_KEY (a plain API key from Google Cloud Console, NOT
// an OAuth client — no consent screen, no per-user auth) raises that quota.
// No paid subscription needed for this part. Real rank tracking / competitor
// backlink analysis are a separate, genuinely paid concern — not attempted
// here, see the Phase 21 SEO audit notes.

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
// A real Lighthouse run commonly takes 15-40s server-side on Google's end —
// generous on purpose so a normal run isn't cut off client-side.
const PSI_TIMEOUT_MS = 55_000;

function scoreToPercent(score) {
  return typeof score === "number" ? Math.round(score * 100) : null;
}

export async function checkPageSpeed(url, { strategy = "mobile" } = {}) {
  if (strategy !== "mobile" && strategy !== "desktop") strategy = "mobile";

  const params = new URLSearchParams({ url, strategy });
  for (const category of ["performance", "seo", "accessibility", "best-practices"]) {
    params.append("category", category);
  }
  if (process.env.GOOGLE_PAGESPEED_API_KEY) params.set("key", process.env.GOOGLE_PAGESPEED_API_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
  } catch (err) {
    const wrapped = new Error(err.name === "AbortError" ? "PageSpeed check timed out." : `PageSpeed check failed: ${err.message}`);
    wrapped.code = err.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `PageSpeed Insights request failed (${res.status}).`;
    const err = new Error(message);
    err.code = res.status === 429 ? "RATE_LIMITED" : "PSI_ERROR";
    throw err;
  }

  const categories = data?.lighthouseResult?.categories || {};
  const audits = data?.lighthouseResult?.audits || {};
  const displayValue = (id) => audits[id]?.displayValue ?? null;

  return {
    url,
    strategy,
    scores: {
      performance: scoreToPercent(categories.performance?.score),
      seo: scoreToPercent(categories.seo?.score),
      accessibility: scoreToPercent(categories.accessibility?.score),
      bestPractices: scoreToPercent(categories["best-practices"]?.score),
    },
    coreWebVitals: {
      largestContentfulPaint: displayValue("largest-contentful-paint"),
      cumulativeLayoutShift: displayValue("cumulative-layout-shift"),
      totalBlockingTime: displayValue("total-blocking-time"),
      firstContentfulPaint: displayValue("first-contentful-paint"),
      speedIndex: displayValue("speed-index"),
    },
    checkedAt: new Date().toISOString(),
  };
}
