# Production Cost Estimate

This document identifies the infrastructure **categories** that will cost
real money to run Autopilon in staging or production. It deliberately
does **not** quote specific current vendor prices — pricing pages change
constantly, vary by region/tier/commitment, and inventing a number here
would go stale immediately and could mislead a real budgeting decision.
Instead, each row names the category, why it exists, roughly how it
scales, and points at where to check real current pricing when you're
ready to buy.

This is meant to help the project owner decide what to provision and
budget for — not a quote, not a bill, not a guarantee.

## How to read the four cost buckets

- **STAGING COST** — what a first, single-instance staging environment
  needs, sized for internal testing traffic (a handful of people, not
  real customers).
- **PRODUCTION COST** — what changes or gets added once real users and
  real traffic exist.
- **OPTIONAL COST** — improves something (reliability, observability,
  compliance posture) but isn't required to launch.
- **VARIABLE USAGE COST** — scales with actual usage in a way that's
  genuinely hard to estimate without real traffic data; budget a range
  and monitor actual spend rather than pre-committing to a number.

## Hosting / Compute

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| A host for `server/index.js` (and, once scaling matters, `server/worker.js` as a separate process) | One small VM/container instance is enough — this is a monolith, not a fleet, until real load says otherwise (Phase 18.8/19's load tests measured comfortably low resource usage at modest concurrency) | Same shape, sized up as real traffic demands; add a second instance once uptime-during-deploys matters | Autoscaling, multiple regions | Compute cost scales with instance size/count, which scales with real traffic — no number here should be treated as a floor or ceiling |
| Container orchestration (if using `Dockerfile`/`docker-compose.yml`) | Not required — a plain `node index.js` on a VM works | A managed container platform (if the team wants that operational model) | — | — |

## Database

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| Persistent disk/volume for `app.sqlite` (WAL mode) | A small persistent volume — SQLite itself has no separate hosting fee the way a managed Postgres/MySQL service would | Same, sized to actual data volume over time | — | Disk cost scales with data volume, which scales with real usage (users, orgs, files, conversation history) |
| Continuous replication (Litestream + an S3-compatible bucket) | Not required for a first staging environment | Recommended once a real RPO/RTO commitment matters | This *is* the optional-but-recommended tier for real production | S3 storage cost for WAL segments — small relative to primary data volume |

## Redis (Cache / Rate Limiting / Session Store)

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| A real Redis instance (managed or self-hosted) | Not required for a single-instance staging box (in-process defaults work); required the moment staging runs more than one app process | Required once there's more than one app process (horizontal scaling, or app+worker sharing rate-limit/session state) | A managed Redis service (vs. self-hosting on the same VM) trades a small recurring fee for less operational burden | Redis cost is mostly flat per-instance-size rather than per-request, so this is one of the more predictable line items |

Note: job queue processing does **not** need Redis in this app's current
architecture — `worker.js` processes share the SQLite `jobs` table
directly (WAL mode), verified for real in Phase 18.3 and again in Phase
19 with a hard-kill durability test. `RedisQueueProvider` exists and is
real/tested but isn't wired into the live path — no cost implication
unless a future genuinely multi-machine job-processing topology needs it.

## Object Storage

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| S3 or S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, self-hosted MinIO) | Recommended to test the real `STORAGE_PROVIDER=s3` code path before production, though the local-disk default works for single-instance staging | Required for any deployment where the filesystem isn't guaranteed to persist/be shared across instances | Choice of provider (R2/B2 often cheaper than S3 for egress-heavy workloads — worth comparing at decision time) | Storage cost scales with actual file volume (uploaded files, generated content); egress/bandwidth cost scales with how often those files are downloaded — neither is estimable without real usage |

## Bandwidth / CDN

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| Outbound bandwidth (API responses, file downloads) | Usually bundled into hosting cost at staging volume | Same, until volume is large enough to matter separately | A CDN in front of the built client (`client/dist`) and/or object storage — reduces origin load and often reduces egress cost for static/file traffic | Directly proportional to real traffic and file-download volume |

## Monitoring / Error Tracking / Alerting

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| External error tracking (Sentry or equivalent) | Not required — structured JSON logs (Phase 18.5) are real, useful input, but nothing external is wired up | Recommended for real operational visibility | This is the optional-but-recommended tier — most providers have a free tier sufficient for early-stage volume | Scales with event/log volume once past the free tier |
| Uptime monitoring / status page / paging | Not required | Recommended once real users depend on uptime | Same as above | Usually flat-fee per monitor/check, not usage-based |

## Email

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| Transactional email provider | **Not integrated in this codebase at all** — nothing to configure yet; this is a missing feature, not a config gap (see `PRODUCTION_READINESS.md`) | Required once the invite/password-reset flow needs to actually send email | — | Once built, cost scales with email volume; most providers have a free tier sufficient for early-stage volume |

## AI Providers

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| At least one of Anthropic/OpenAI/Gemini API key (`AI_PROVIDER`) | Required — every agent execution/chat message needs a real key, even in staging | Required | Multiple provider keys for failover (the provider abstraction already supports this) | **This is the platform's single largest and most usage-dependent cost.** Every agent turn, chat message, and content-generation call is a real, metered API call. No per-token number is asserted here — check each provider's current pricing, and budget with real usage projections, not a guess. Phase 16's existing per-org spend limits (`orchestrator/billing.js`) are the guardrail against this running away unexpectedly. |
| Optional search provider key (Tavily/Brave/SerpAPI) | Optional | Optional | Only relevant if the web-search tool/skill is used | Usage-based, smaller than the core AI-provider cost |

## Payment Processing

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| Stripe account | Test mode is free — this is exactly what it's for | Live mode, real per-transaction fees | — | Stripe's own published fee structure applies once real payments flow; not invented here |

## Domain / DNS / TLS

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| Domain registration | Required (or a staging subdomain of a production domain) | Required | — | Flat annual fee, low |
| DNS management | Usually bundled with domain/hosting | Same | A dedicated DNS provider for advanced features (geo-routing, DNSSEC) | — |
| TLS certificate | Free (Let's Encrypt) or bundled with most hosting platforms/CDNs | Same | — | — |

## Mobile Developer Accounts

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| Google Play Developer account | Not required for internal/debug-build testing | Required to publish on the Play Store | — | One-time registration fee |
| Apple Developer Program membership | Not required for internal testing | Required to publish on the App Store, and for real APNs push | — | Annual membership fee |
| Firebase project (push notifications) | Optional — the app works without it, push just stays disabled | Required if push notifications are a launch feature | — | Free tier (FCM) is generous; unlikely to be a real cost driver at typical scale |

## Other

| Category | Staging | Production | Optional | Variable |
|---|---|---|---|---|
| CI/CD (GitHub Actions) | Free tier is typically sufficient for a project this size — Phase 19 verified the actual pipeline (8 jobs, ~2 minutes total) fits comfortably within GitHub's free-tier minutes for a private or public repo | Same, until build volume is very high | — | Scales with build minutes if usage grows well beyond typical |
| Load testing at real scale | Not required to launch | Recommended once before making any real capacity claim | A dedicated load-testing service (vs. running `scripts/load-test.js` from a second real host) | Short-lived cost — a single real load-test run against real staging infrastructure, not a recurring line item |

## Summary — what genuinely can't be deferred

**To stand up ANY real staging environment**: a host, a domain + DNS +
TLS, and at least one real AI provider key. Everything else in this
document can be deferred, with the specific feature it gates staying
disabled/untested, without blocking a first staging deployment — see
`LAUNCH_BLOCKERS.md` for the same information prioritized P0-P3.

**The single cost line item most likely to surprise someone**: AI
provider usage. Unlike hosting/database/Redis (which are roughly flat,
predictable per-instance costs), AI API usage scales directly with
product usage and has no natural ceiling without the org-level spend
limits this app already enforces (`orchestrator/billing.js`) — make sure
those limits are configured to real, intentional values before real
users arrive, not left at whatever development defaults exist.
