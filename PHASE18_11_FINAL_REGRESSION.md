# Phase 18.11 — Final Security Regression Re-Run

All 4 existing regression suites re-run against a live server with every
Phase 18 infrastructure change simultaneously active: security headers
(helmet + Permissions-Policy), production-aware CORS, structured
request/response logging, startup env validation, and — genuinely, not
just configured — the real Redis-backed cache, rate-limiter, and session
store providers all selected at once (`CACHE_PROVIDER=redis
RATE_LIMIT_PROVIDER=redis SESSION_STORE=redis`, a real local `redis-server`
running).

## Result: 76/76 checks passed

| Suite | Checks | Result |
|---|---|---|
| Phase 16 security regression | 24 | 24/24 PASS |
| Public API security regression | 30 | 30/30 PASS |
| Idempotency-Key regression | 10 | 10/10 PASS |
| Integration Action API regression | 12 | 12/12 PASS |

Confirmed the Redis providers were genuinely exercised, not just selected
and silently unused: after the run, `redis-cli keys "*"` on the real
instance showed real `sess:*` keys (one per session created during the
suites — proves `SESSION_STORE=redis` actually stored real sessions, not
falling back to MemoryStore) and real `ratelimit:global:*`/
`ratelimit:auth:*`/`ratelimit:public_api:*`/`ratelimit:ai_burst:*` keys
(proves `RATE_LIMIT_PROVIDER=redis` actually counted real requests from
the suites, across every limiter tier — global, login, Public API
per-key, AI burst). No `cache:*` keys is the *correct*, expected result,
not a gap: per Phase 18.2's design, `cached()`'s three hot-path callers
(`billing.getPlan`, `featureFlags.isFeatureEnabled`,
`maintenanceMode.maintenanceStatus`) are permanently wired to the
in-process cache regardless of `CACHE_PROVIDER`, specifically so they
never depend on Redis being reachable — see `cacheProvider.js`'s own
comments for why.

## A real bug found and fixed during this final pass

The very first attempt at this run used `NODE_ENV=production` (to test the
most production-realistic configuration possible) and the Phase 16
regression suite immediately crashed with a `NOT NULL constraint failed`
error — not a flaky test, a real, reproducible finding.

**Root cause**: `index.js`'s session cookie has always set `secure:
process.env.NODE_ENV === "production"` (a Phase 16-era setting, correct
and necessary for real security — a session cookie must never be sent
over plain HTTP in production). Express's session middleware only sets a
`Secure`-flagged cookie when `req.secure` is true, and `req.secure` is
only true for a connection Express itself terminated TLS on. **Every
realistic production deployment sits behind a TLS-terminating reverse
proxy or load balancer** (nginx, a platform's own LB, Cloudflare, etc.) —
the connection this Node process actually sees is plain HTTP, with the
proxy reporting the original scheme via the standard `X-Forwarded-Proto`
header. Without Express's `trust proxy` setting, that header is ignored,
`req.secure` is always false, and — **the session cookie is silently
never sent, at all, ever, in any real production deployment** — meaning
signup and login would appear to succeed (200, correct user object
returned) while the browser never receives anything to send back on the
next request. Every subsequent authenticated call would 401. This is a
complete, silent, production-breaking bug that would have made the
platform's own hardened cookie security setting (`secure: true`, exactly
the right setting) impossible to actually use.

**Fix**: `index.js` now calls `app.set("trust proxy", 1)` when
`NODE_ENV === "production"` — trusting exactly one hop (the single load
balancer/reverse proxy in a standard single-tier deployment), not
arbitrary client-supplied headers with no proxy in front at all (dev/test
environments, which don't set `NODE_ENV=production`, are unaffected and
keep today's behavior).

**Verified for real**, not just reasoned about: booted a live server with
`NODE_ENV=production`, confirmed a signup request with no
`X-Forwarded-Proto` header still correctly sets no cookie (safe default —
an actually-unproxied plain HTTP connection in production shouldn't get a
Secure cookie either); then sent the exact header a real reverse proxy
sends (`X-Forwarded-Proto: https`) and confirmed the session cookie is now
correctly returned, `Secure` flag and all. This is the exact mechanism a
real staging/production deployment behind any standard reverse proxy will
exercise — confirmed working, not assumed.

This finding is a strong argument for why Task 75's "run everything
together" pass matters even after every individual Phase 18 sub-task was
already tested in isolation: no earlier task tested `NODE_ENV=production`
+ a live login flow together, because the cookie-security work (18.4) and
the env-validation work (18.1) were each tested against the specific thing
they changed, not against each other's interaction. This is now fixed and
covered going forward.

## What "full stack" means for this run, precisely

- `SESSION_SECRET`/`BYOK_ENCRYPTION_KEY`: real, valid values (required —
  `config/env.js` would otherwise refuse to boot in production).
- `REDIS_URL=redis://localhost:6379`: a real local `redis-server`.
- `CACHE_PROVIDER=redis`, `RATE_LIMIT_PROVIDER=redis`,
  `SESSION_STORE=redis`: all three real Redis-backed providers selected
  simultaneously (not tested individually this time — together).
- `QUEUE_PROVIDER` left at its default (`in_process`) — per Phase 18.3's
  documented design, this is the permanent, correct choice for the
  existing synchronous job-enqueue call sites; not a gap in this run.
- Security headers (helmet + Permissions-Policy), CORS, and structured
  request logging (Phase 18.4/18.5) are unconditional — always active
  regardless of these env vars, confirmed active via response headers and
  log output during the run.
