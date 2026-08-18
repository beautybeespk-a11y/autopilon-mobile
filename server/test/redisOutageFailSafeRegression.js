// Phase 19 §16/§34/§36 — real Redis-outage failure-mode regression. Uses a
// REAL local redis-server (spawned and then SIGKILLed, not mocked) and a
// real booted server pointed at it with CACHE_PROVIDER=redis,
// RATE_LIMIT_PROVIDER=redis, SESSION_STORE=redis. Found via this exact
// test methodology during Phase 19: (1) /api/health/live was hanging for
// the length of ioredis's full retry exhaustion during a Redis outage
// instead of responding instantly, because session middleware ran before
// it and needed Redis; (2) any unhandled Redis error fell through to
// Express's default HTML error page, leaking real server filesystem paths
// in a stack trace; (3) the global rate limiter — applied to literally
// every /api/* request — failed CLOSED on a Redis error, meaning a single
// Redis blip took down 100% of API traffic, not just rate-limiting.
// All three are fixed in index.js / orchestrator/rateLimiter.js /
// routes/health.js; this test locks in the two fully deterministic
// guarantees (liveness independence, no stack-trace leak). The rate
// limiter's fail-open behavior and session-store's deliberate fail-closed
// behavior are both real and were verified manually during this phase
// (see PHASE19_NOTES.md) but aren't re-asserted here with the same
// precision, since their timing depends on ioredis's real reconnect
// backoff and isn't worth making this suite's runtime unpredictable for.
//
//   node test/redisOutageFailSafeRegression.js
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const REDIS_PORT = 6396;
const APP_PORT = 4109;
const DB_PATH = "/tmp/redis-outage-failsafe-regression.sqlite";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, err: err.message });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health/live`);
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  throw new Error(`server on port ${port} never became live within ${timeoutMs}ms`);
}

try { execSync(`rm -f ${DB_PATH} ${DB_PATH}-shm ${DB_PATH}-wal`); } catch {}

console.log("Starting a real redis-server...");
const redisProc = spawn("redis-server", ["--port", String(REDIS_PORT), "--daemonize", "no", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
await sleep(1000);

console.log("Booting the app against it (CACHE/RATE_LIMIT/SESSION all real Redis-backed providers)...");
const serverProc = spawn(process.execPath, ["index.js"], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    DB_PATH,
    SESSION_SECRET: "a-development-only-session-secret-value-32chars",
    BYOK_ENCRYPTION_KEY: "a-development-only-byok-key-value-32characters",
    REDIS_URL: `redis://localhost:${REDIS_PORT}`,
    CACHE_PROVIDER: "redis",
    RATE_LIMIT_PROVIDER: "redis",
    SESSION_STORE: "redis",
    PORT: String(APP_PORT),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
serverProc.stderr.on("data", () => {}); // drain

await waitForHealth(APP_PORT);

await check("baseline: liveness check succeeds while Redis is healthy", async () => {
  const res = await fetch(`http://localhost:${APP_PORT}/api/health/live`);
  assert.equal(res.status, 200);
});

console.log("Hard-killing redis-server (SIGKILL) to simulate a real outage...");
redisProc.kill("SIGKILL");
await sleep(1000);

await check("liveness check responds almost instantly during a real Redis outage — it must never depend on Redis", async () => {
  const start = Date.now();
  const res = await fetch(`http://localhost:${APP_PORT}/api/health/live`, { signal: AbortSignal.timeout(3000) });
  const elapsedMs = Date.now() - start;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(elapsedMs < 2000, `expected liveness to respond in well under 2s during a Redis outage, took ${elapsedMs}ms`);
});

await check("an endpoint that hits a genuinely broken Redis-backed code path never leaks a raw stack trace or internal file path — only clean JSON", async () => {
  // /api/health/ready is also mounted early (session/Redis-independent)
  // and only checks the database, so it stays healthy — this check
  // instead confirms the RESPONSE SHAPE contract for anything that DOES
  // error: content-type JSON, no HTML, no node_modules/server file path
  // anywhere in the body. Uses the admin-only /api/health/redis path
  // (reached through the Redis-backed session/rate-limiter middleware,
  // which is exactly the real path that used to leak a stack trace).
  const res = await fetch(`http://localhost:${APP_PORT}/api/health/redis`, { signal: AbortSignal.timeout(5000) });
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  assert.ok(contentType.includes("application/json"), `expected a JSON error response, got content-type "${contentType}" — body: ${text.slice(0, 300)}`);
  assert.ok(!/<html/i.test(text), "response body must never be an HTML error page");
  assert.ok(!/node_modules|\/server\/|at Socket\.|at Object\./.test(text), `response body leaked what looks like a raw stack trace / internal file path: ${text.slice(0, 300)}`);
});

serverProc.kill("SIGKILL");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} Redis-outage fail-safe checks passed.`);
try { execSync(`rm -f ${DB_PATH} ${DB_PATH}-shm ${DB_PATH}-wal`); } catch {}
if (failed.length) process.exit(1);
