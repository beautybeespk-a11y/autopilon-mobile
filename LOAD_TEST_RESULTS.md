# Load Test Results (Phase 18 §40, re-verified Phase 19 §35)

**Every number below is measured, not estimated** — from a real run of
`server/scripts/load-test.js` (autocannon-based) against a locally-booted
dev server in this sandboxed environment, run on 2026-08-17.

**Re-run for Phase 19 on 2026-08-18** against a freshly booted server —
same methodology, same scenarios. Results below are the Phase 19 numbers;
they're consistent with the original Phase 18 run (single-digit-ms p50s
across health/authenticated endpoints, bcrypt-dominated login latency, zero
errors) — see "Known limitations" for why this is still a staging-sandbox
measurement, not a production capacity claim, in both runs.

## What these numbers are — and are not

**They ARE:** real, reproducible latency/throughput measurements of this
exact codebase's request-handling path (Express + SQLite + session/API-key
auth), captured with a real HTTP load-testing tool against a real running
process.

**They are NOT:**
- **A production capacity claim.** This ran single-process, on shared
  sandbox hardware, against a fresh near-empty SQLite database, from one
  client process on the same machine (zero network latency, zero real
  internet variance). Production capacity depends on real hardware, a
  production-sized dataset, and real network conditions — none of which
  this environment can provide. Do not quote these req/s numbers as "the
  platform can handle X requests/second in production."
- **A test of raw endpoint throughput without any rate limiting.** This
  app's own rate limiters (Phase 16/18) are real security controls, and
  the results below are intentionally shaped around them rather than
  bypassing them — see "Methodology" below for why that matters.

## Methodology

This app has two layers of per-IP/per-key rate limiting active during
every request (`orchestrator/rateLimiter.js`, `publicApi/rateLimit.js`):

- **Global**: 300 requests / 60s per source IP, across all of `/api`.
- **Login-specific**: 10 requests / 60s per source IP (`routes/auth.js`) —
  intentional brute-force protection.
- **Public API, per key, plan-based**: free plan = 60 requests / 60s
  (`publicApi/rateLimit.js`'s `PLAN_LIMITS`).

A naive "hammer every endpoint as fast as possible from one connection
pool" load test — the obvious first thing to try — mostly measures how
fast this app returns `429 Too Many Requests` to a single IP that looks
abusive, which is a **security feature working correctly**, not a useful
capacity number. (We hit this directly on the first run: see
"Rate-limiter saturation demonstration" below.)

So the actual latency/throughput scenarios below each stay within a
`amount` (total request count) safely under the relevant limiter's real
budget, with a 62-second cooldown between scenarios so the shared global
limiter's window resets. This measures genuine handler latency, not 429
rejection noise — while still real-world-honestly reflecting that this
app's rate limits are active and correctly enforced throughout.

## Results — genuine handler latency (within real rate-limit budgets)

Phase 18 original run (2026-08-17):

| Scenario | Requests | Connections | req/s (avg) | Latency p50 | Latency p99 | Latency max | Non-2xx |
|---|---|---|---|---|---|---|---|
| `GET /api/health/live` (unauthenticated) | 250 | 5 | 250 | 3ms | 15ms | 21ms | 0 |
| `GET /api/health/ready` (unauthenticated, DB check) | 250 | 5 | 250 | 3ms | 11ms | 19ms | 0 |
| `POST /api/auth/login` (bcrypt password check) | 8 | 2 | 8 | 213ms | 239ms | 239ms | 0 |
| `GET /api/agents` (session-authenticated) | 250 | 5 | 250 | 6ms | 10ms | 17ms | 0 |
| `GET /api/tasks` (session-authenticated) | 250 | 5 | 250 | 4ms | 13ms | 13ms | 0 |
| `GET /api/v1/agents` (Public API, free-plan 60/60s budget) | 55 | 5 | 55 | 6ms | 12ms | 12ms | 0 |

Phase 19 re-run (2026-08-18), freshly booted server, same scenarios:

| Scenario | Requests | Connections | req/s (avg) | Latency p50 | Latency p99 | Latency max | Non-2xx |
|---|---|---|---|---|---|---|---|
| `GET /api/health/live` (unauthenticated) | 250 | 5 | 250 | 4ms | 17ms | 18ms | 0 |
| `GET /api/health/ready` (unauthenticated, DB check) | 250 | 5 | 250 | 2ms | 8ms | 12ms | 0 |
| `POST /api/auth/login` (bcrypt password check) | 8 | 2 | 8 | 175ms | 278ms | 278ms | 0 |
| `GET /api/agents` (session-authenticated) | 250 | 5 | 250 | 5ms | 11ms | 11ms | 0 |
| `GET /api/tasks` (session-authenticated) | 250 | 5 | 250 | 4ms | 7ms | 11ms | 0 |
| `GET /api/v1/agents` (Public API, free-plan 60/60s budget) | 55 | 5 | 55 | 5ms | 23ms | 23ms | 0 |

**Zero errors, zero timeouts, zero unexpected non-2xx responses across
every scenario, both runs.** The small run-to-run variance (a few ms here
and there, login p50 175ms vs 213ms) is normal sandbox-hardware noise, not
a regression — both runs are well within the same overall shape.

Notable, real observations:
- **Login is ~40-70x slower than every other endpoint** (p50 213ms vs.
  3-6ms elsewhere) — this is bcrypt's deliberate cost, not a bug. Password
  hashing is supposed to be slow; this confirms it's actually happening on
  every login, not skipped or cached.
- Authenticated endpoints (`/api/agents`, `/api/tasks`) are barely slower
  than the unauthenticated health checks (single-digit ms difference) —
  session lookup + a SQLite query add negligible overhead at this data
  size.
- The Public API path (API-key auth + scope check + rate-limit lookup)
  costs about 1-2ms more than session auth, still comfortably sub-10ms.

## Rate-limiter saturation demonstration (NOT a capacity number)

A separate, deliberately labeled run: `GET /api/health/live` sustained for
8 seconds at 10 connections, with no request-count cap — i.e., the "naive"
approach described above, kept here because the result itself is a real,
useful finding.

| Metric | Value (Phase 18, 2026-08-17) | Value (Phase 19 re-run, 2026-08-18) |
|---|---|---|
| Total requests sent | 16,436 | 18,863 |
| Requests returning non-2xx (429) | 16,126 (98.1%) | 18,553 (98.4%) |
| req/s avg (including rejected requests) | 2,053 | 2,357 |
| Latency p50 / p99 (including rejected requests) | 4ms / 11ms | 3ms / 17ms |

**What this shows:** once a single source IP exceeds the global 300/60s
budget (which happens almost immediately at this concurrency), the app
correctly and cheaply rejects the excess with `429` — the rejection path
itself is fast (rejecting is *cheaper* than serving, as expected), and the
limiter did not let a burst overwhelm the actual health-check logic. This
is the rate limiter working as designed, verified under real load — not
evidence of a performance problem, and not a throughput ceiling to quote
as "capacity" (a real deployment's legitimate traffic comes from many
different users/IPs, each individually well under this per-IP budget).

## Known limitations of this test

- **Single process, single machine, shared sandbox hardware.** No
  isolation from other processes/tenants that may be running on the same
  underlying host.
- **Near-empty database** (one test org, one agent, one task). Query
  latency will grow with real production data volume — this test does not
  characterize that.
- **No network latency** — client and server are on `localhost`. A real
  deployment adds real network round-trip time on top of every number
  above.
- **No concurrent AI-provider calls tested** — the AI-heavy endpoints
  (agent execution, content generation) were not load tested here, since
  they depend on external provider latency (OpenAI/Anthropic/Gemini) which
  this sandboxed environment cannot exercise realistically without real
  provider credentials and real API calls at volume (which would also
  incur real cost). See `EXTERNAL_INFRASTRUCTURE.md`.
- **No horizontal scaling tested** — this measures one server process.
  Phase 18.3's `worker.js` and Phase 18.2's Redis-backed cache/rate-limiter
  make horizontal scaling architecturally real, but actual multi-instance
  load testing needs a real multi-machine or multi-container deployment,
  not available here.

## Reproducing this test

```bash
cd server
node index.js &            # boot the server (needs SESSION_SECRET/BYOK_ENCRYPTION_KEY
                            # in production; dev defaults work locally)
npm run load-test          # takes ~7 minutes due to the deliberate cooldowns
```

## Phase 19 addition: controlled failure/chaos testing

Load testing measures the happy path; Phase 19 also added real controlled
failure testing (kill Redis mid-run, kill a worker process mid-job) —
see `PHASE19_NOTES.md` and `server/test/redisOutageFailSafeRegression.js`
/ `server/test/multiWorkerRealProcessRegression.js` /
`server/test/workerCrashReclaimRegression.js` for the methodology and
real bugs found and fixed as a result (a liveness check that used to hang
during a Redis outage, a rate limiter that used to fail closed and take
down the whole API, an unhandled-error path that used to leak a stack
trace, and a worker-crash job reclaim gap). This section is about
throughput/latency only; that section is about what happens when a
dependency actually goes down.
