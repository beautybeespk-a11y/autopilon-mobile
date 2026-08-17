#!/usr/bin/env node
// Real load testing (Phase 18 §40) — autocannon against a LOCALLY-BOOTED,
// ALREADY-RUNNING dev server (same "real, not simulated" discipline as
// every other Phase 18 test script). Every number this script prints is
// measured from an actual run, never invented.
//
// IMPORTANT: these are single-process, sandboxed dev-instance
// measurements from ONE source IP — NOT a production capacity claim, and
// deliberately shaped around this app's own real rate limiters rather
// than fighting them:
//   - orchestrator/rateLimiter.js's global limiter caps any single IP at
//     300 requests/60s across all of /api.
//   - routes/auth.js's login route has its own tighter limiter: 10/60s.
// A naive "hammer everything as fast as possible from one connection
// pool" run mostly measures how fast this app returns 429s to a single
// abusive-looking IP — a real, working security feature, but not a
// useful latency/throughput number. So each scenario below stays under
// its real budget (a small `amount` of requests, not a long `duration`),
// with a cooldown between scenarios so the shared global-limiter window
// resets. One separate, clearly-labeled "saturation" run demonstrates the
// limiter itself doing its job, honestly reported as exactly that.
//
// See LOAD_TEST_RESULTS.md for the full write-up of measured numbers.
//
// Usage: node scripts/load-test.js [baseUrl]
import autocannon from "autocannon";

const BASE = process.argv[2] || process.env.LOAD_TEST_BASE_URL || "http://localhost:4000";
const COOLDOWN_MS = 62_000; // > the global rate limiter's 60s window

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSession() {
  let cookie = null;
  return {
    async req(method, path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json, cookie: () => cookie };
    },
  };
}

async function setupFixtures() {
  const stamp = Date.now();
  const email = `loadtest-${stamp}@example.com`;
  const password = "LoadTest123!";

  const session = makeSession();
  const signupRes = await session.req("POST", "/api/auth/signup", { email, password, name: "Load Test User" });
  if (signupRes.status !== 200 && signupRes.status !== 201) throw new Error(`Signup failed: ${JSON.stringify(signupRes.json)}`);
  const sessionCookie = signupRes.cookie();

  const orgRes = await session.req("POST", "/api/organizations", { name: "Load Test Org" });
  const orgId = orgRes.json?.id;
  if (!orgId) throw new Error(`Org creation failed: ${JSON.stringify(orgRes.json)}`);

  const keyRes = await session.req("POST", `/api/organizations/${orgId}/developer/api-keys`, {
    name: "Load test key",
    scopes: ["agents:read", "tasks:read"],
  });
  const apiKey = keyRes.json?.rawKey;
  if (!apiKey) throw new Error(`API key creation failed: ${JSON.stringify(keyRes.json)}`);

  await session.req("POST", "/api/agents", { name: "Load Test Agent", description: "", skills: [] });
  await session.req("POST", "/api/tasks", { title: "Load test task", priority: "medium" });

  return { email, password, sessionCookie, apiKey };
}

function runAutocannon(opts) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(opts, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    autocannon.track(instance, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

function summarize(name, result) {
  return {
    name,
    connections: result.connections,
    totalRequests: result.requests.sent,
    requestsPerSecond: { avg: result.requests.average, min: result.requests.min, max: result.requests.max },
    latencyMs: { avg: result.latency.average, p50: result.latency.p50, p97_5: result.latency.p97_5, p99: result.latency.p99, max: result.latency.max },
    throughputBytesPerSecond: result.throughput.average,
    non2xx: result.non2xx,
    errors: result.errors,
    timeouts: result.timeouts,
  };
}

async function main() {
  console.log(`Load testing ${BASE} — budget-limited scenarios (see script header for why), with cooldowns between them.\n`);
  console.log("Setting up test fixtures (user, org, API key, sample agent/task)...");
  const fixtures = await setupFixtures();
  console.log("Fixtures ready.\n");

  // Each "amount" is chosen to stay safely under whichever real rate
  // limiter governs that endpoint, so results reflect genuine handler
  // latency, not 429 rejection noise. connections=5 gives real concurrency
  // without amount/connections leaving requests unsent.
  const latencyScenarios = [
    { name: "GET /api/health/live (unauthenticated)", opts: { url: `${BASE}/api/health/live`, method: "GET", connections: 5, amount: 250 } },
    { name: "GET /api/health/ready (unauthenticated, DB check)", opts: { url: `${BASE}/api/health/ready`, method: "GET", connections: 5, amount: 250 } },
    {
      name: "POST /api/auth/login (bcrypt password check — budget matches its own 10/60s limiter)",
      opts: { url: `${BASE}/api/auth/login`, method: "POST", connections: 2, amount: 8, headers: { "content-type": "application/json" }, body: JSON.stringify({ email: fixtures.email, password: fixtures.password }) },
    },
    {
      name: "GET /api/agents (session-authenticated)",
      opts: { url: `${BASE}/api/agents`, method: "GET", connections: 5, amount: 250, headers: { cookie: fixtures.sessionCookie } },
    },
    {
      name: "GET /api/tasks (session-authenticated)",
      opts: { url: `${BASE}/api/tasks`, method: "GET", connections: 5, amount: 250, headers: { cookie: fixtures.sessionCookie } },
    },
    {
      // publicApi/rateLimit.js has ITS OWN per-key limit on top of the
      // global one — free plan (this fixture's default) is 60/60s, tighter
      // than the global 300/60s budget the other scenarios use, so this
      // one needs a smaller amount to get clean (non-429) latency numbers.
      name: "GET /api/v1/agents (Public API, API-key-authenticated, free-plan 60/60s budget)",
      opts: { url: `${BASE}/api/v1/agents`, method: "GET", connections: 5, amount: 55, headers: { authorization: `Bearer ${fixtures.apiKey}` } },
    },
  ];

  const results = [];
  for (const scenario of latencyScenarios) {
    console.log(`Running: ${scenario.name} ...`);
    const result = await runAutocannon(scenario.opts);
    const summary = summarize(scenario.name, result);
    results.push(summary);
    console.log(`  ${summary.totalRequests} requests, ${summary.requestsPerSecond.avg} req/s avg, latency p50=${summary.latencyMs.p50}ms p99=${summary.latencyMs.p99}ms, non2xx=${summary.non2xx}, errors=${summary.errors}\n`);
    console.log(`  Cooling down ${COOLDOWN_MS / 1000}s for the global rate limiter's window to reset...\n`);
    await sleep(COOLDOWN_MS);
  }

  // Separate, deliberately-labeled: demonstrates the global per-IP rate
  // limiter itself, not endpoint capacity. Success criterion here is
  // "large majority of requests correctly rejected with 429 once the
  // 300/60s budget is exhausted," not a high req/s number.
  console.log("Running rate-limiter saturation check (GET /api/health/live, sustained duration, deliberately exceeds the 300/60s global budget)...");
  const saturation = await runAutocannon({ url: `${BASE}/api/health/live`, method: "GET", connections: 10, duration: 8 });
  const saturationSummary = summarize("Rate-limiter saturation demonstration (NOT a capacity number)", saturation);
  console.log(`  ${saturationSummary.totalRequests} requests sent, ${saturationSummary.non2xx} returned non-2xx (429, expected) — global limiter is ${saturationSummary.non2xx > 0 ? "ACTIVE and correctly enforcing its budget" : "NOT enforcing — investigate"}.\n`);

  console.log("\n=== Full results (JSON) ===");
  console.log(JSON.stringify({
    baseUrl: BASE,
    timestamp: new Date().toISOString(),
    latencyScenarios: results,
    rateLimiterSaturationDemo: saturationSummary,
  }, null, 2));
}

main().catch((err) => {
  console.error("Load test failed:", err.message);
  process.exit(1);
});
