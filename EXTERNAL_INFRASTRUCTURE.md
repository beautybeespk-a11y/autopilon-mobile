# External Infrastructure Requirements

Everything Autopilon needs that **cannot be provisioned from this sandboxed
development environment** — no cloud account access, no ability to
register real domains, no outbound access to most third-party consoles,
no real payment/OAuth credentials. For each item: why it's needed, whether
staging needs it, whether production needs it, and an honest cost
*category* (no specific current pricing is invented — check each
provider's own pricing page at deployment time).

## Compute / Hosting

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A host to run `server/index.js` (and, once scaling matters, `server/worker.js`) | The app is a real Node/Express process — nothing here is serverless-native | Required | Required | Low-to-moderate (a single small VM/container is enough for staging and modest production traffic; this is a monolith, not a fleet, until real load says otherwise) |
| Container runtime / orchestrator (optional) | `Dockerfile`/`docker-compose.yml` exist (Phase 18.7) but are **syntax-reviewed only, not build-tested** — no Docker daemon in this sandbox | Optional (a plain `node index.js` on a VM works too) | Optional, recommended for the worker/redis/app topology `docker-compose.yml` describes | Free (self-hosted) to moderate (managed container platform) |

## Database

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| Persistent disk/volume for `app.sqlite` | The app is SQLite-based (WAL mode) — `DB_PATH` (Phase 18.7) lets this point at a mounted volume so the file survives container recreation | Required | Required | Low (a small persistent volume; SQLite has no separate hosting cost the way Postgres/MySQL would) |
| Litestream + an S3-compatible bucket for continuous replication | `BACKUP_RESTORE.md` (Phase 18.6) documents this as the recommended real production backup strategy — the built `backup-db.js`/`restore-db.js` are real and tested but are a *scheduled snapshot* mechanism (RPO = backup interval), not continuous | Recommended | Required for a real RPO/RTO commitment | Low (S3 storage cost for small WAL segments + zero compute if run as a sidecar) |

## Cache / Rate Limiting / Session Store / Queue

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A real Redis instance (managed or self-hosted) | `CACHE_PROVIDER=redis`, `RATE_LIMIT_PROVIDER=redis`, `SESSION_STORE=redis` (Phase 18.2/18.4) are real, tested, ioredis-backed implementations — verified against a real local `redis-server` in this sandbox, but never against a managed cloud Redis | Required for any multi-instance staging setup; optional for a single-instance staging box (in-process defaults still work there) | Required the moment there is more than one app process (horizontal scaling, or just app+worker as separate processes needing to share rate-limit/session state) | Low (a small managed Redis instance is inexpensive; self-hosting on the same VM as the app is free but couples their lifecycle) |

Job processing itself (Phase 18.3) does **not** need Redis — `worker.js`
processes share the SQLite `jobs` table directly (WAL mode supports this
safely across processes on the same disk), tested for real with two
concurrent worker processes. A `RedisQueueProvider` exists and is real/
tested at the adapter level but is deliberately not wired into the app's
default job-enqueue path (see `jobs/queueProvider.js`'s own comments) —
only relevant if a genuinely multi-machine (not just multi-process)
job-processing topology is ever needed.

## Object Storage

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| An S3 bucket or S3-compatible storage (R2, B2, MinIO, etc.) | `STORAGE_PROVIDER=s3` is already fully implemented (Phase 14, `@aws-sdk/client-s3`) — real, not architecture-only. `STORAGE_PROVIDER=local` (the default) writes to local disk, which is wrong for any multi-instance or ephemeral-filesystem deployment | Recommended (to test the real code path before production) | Required for any deployment where the filesystem isn't guaranteed to persist/be shared across instances | Low (object storage is cheap per-GB; cost scales with actual file volume, which this environment has no way to estimate) |

## Domain, DNS, SSL/TLS

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A registered domain (or subdomain of one) | `CLIENT_ORIGIN`/`APP_BASE_URL`/OAuth redirect URIs/webhook endpoints all need a real, stable URL — nothing here can be tested against `localhost` in any way that resembles production | Required | Required | Low (domain registration is inexpensive annually) |
| DNS management | Point the domain at the hosting provider | Required | Required | Usually bundled with domain/hosting |
| TLS certificate | Phase 18.4's security headers (HSTS) and Phase 18.11's `trust proxy` fix both assume a real TLS-terminating reverse proxy in front of the app | Required | Required | Free (Let's Encrypt) to low (most hosting platforms/CDNs provision this automatically) |

## AI Providers

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A real API key for at least one of Anthropic/OpenAI/Gemini (`AI_PROVIDER`) | The entire product is an AI agent platform — every agent execution/chat message needs a real provider key. `config/env.js` already warns loudly at boot if this is missing in production | Required | Required | Variable, usage-based — this is the platform's largest and most usage-dependent cost; no current per-token pricing is asserted here, check each provider's own pricing |
| Search provider key (Tavily/Brave/SerpAPI) — optional | Only needed if the web-search tool/skill is actually used | Optional | Optional | Low-to-variable, usage-based |

## OAuth Integrations

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A real Google Cloud project + OAuth client (Gmail/Calendar/Drive/Docs/Sheets) | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` — Phase 18.10 found and fixed a real CSRF-token-strength bug in this flow, but the flow itself has never been exercised against a real Google account (no credentials available here) | Required to test the real OAuth flow before launch | Required if these integrations are offered | Free for the OAuth app itself; API usage may have its own quotas/limits per Google's terms |
| A real Meta developer app (Ads + WhatsApp Business) | `META_APP_ID`/`META_APP_SECRET`/`META_REDIRECT_URI` — same status as Google: code-reviewed and one real bug fixed, never tested against a real Meta account | Required to test the real OAuth flow before launch | Required if these integrations are offered | Free for the app itself; WhatsApp Business API has its own usage-based pricing |

See `PHASE18_10_OAUTH_BILLING_ADMIN_REVIEW.md` for the exact staging setup
steps for both.

Shopify/WooCommerce/WordPress do **not** need OAuth apps — they're
manual-token/application-password integrations configured per-connection
by the end user, nothing platform-level to provision.

## Payments

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A real Stripe account (test mode for staging, live mode for production) | `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` — the webhook handler itself is real and was verified correct on code review (Phase 18.10: real signature verification via Stripe's SDK, real idempotency, correct retry semantics) but has never received a real webhook from Stripe, since no Stripe account exists here | Required (Stripe's test mode is free and this is exactly what it's for) | Required for real billing | Stripe's own per-transaction fee structure — not invented here |
| A registered webhook endpoint in the Stripe dashboard pointing at `<APP_BASE_URL>/api/stripe/webhook` | Stripe webhooks need a real, reachable HTTPS URL to send events to | Required | Required | No separate cost |

## Mobile Push Notifications

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A real Firebase project + service account | `FIREBASE_SERVICE_ACCOUNT_JSON` — push notifications are fully implemented (`firebase-admin`) but untested against a real device/real FCM delivery in this sandbox | Optional (app works without it; push just stays disabled) | Required if push notifications are a launch feature | Free tier is generous for FCM; unlikely to be a real cost driver |
| Apple Push Notification service (APNs) certificate/key, for iOS | Required for push on iOS specifically, separate from FCM's Android path | Optional | Required for iOS push | Requires an active Apple Developer Program membership (see below) |

## Email

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A transactional email provider (none currently integrated) | `routes/organizations.js`'s member-invite flow has a code comment noting "no outbound email exists yet" — invited users must be told out-of-band today. Password reset (`/auth/forgot-password`) likely has the same gap — **not verified in this review pass**, flagging for the next security/privacy pass | Recommended | Required for a real invite/password-reset flow | Low (most transactional email providers have a free tier sufficient for early-stage volume) |

## Monitoring / Error Tracking / Alerting

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| An external uptime/error-tracking service (Sentry, Datadog, a status-page provider, etc.) | Phase 18.5 built real structured JSON logging + request IDs + expanded health checks (including real Redis connectivity) — genuinely useful *input* for a monitoring system, but no external monitoring service itself is integrated. Nothing here pages anyone on a real outage | Recommended | Required for real operational visibility | Free tier often sufficient for early-stage volume; scales with event/log volume |

## Load Testing at Real Scale

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A staging environment on real infrastructure, plus a load-generation source separate from the app server | `LOAD_TEST_RESULTS.md` (Phase 18.8) has real, measured single-process sandboxed numbers — explicitly not a production capacity claim. A real capacity number needs real hardware, a realistic dataset size, and real network conditions | Recommended before any capacity claim is made externally | N/A (this is a testing activity, not a permanent requirement) | Low (a short load test run is cheap; don't run it against production) |

## Mobile App Distribution

| Item | Why needed | Staging? | Production? | Cost category |
|---|---|---|---|---|
| A Google Play Developer account | Required to publish the Android app; Phase 18.9 replaced the hardcoded dev URL with `--dart-define` environment config, but the `android/`/`ios/` platform folders in this repo were never fully scaffolded (no Flutter SDK available anywhere this project has been built) — a real `flutter create`/build pass is needed before this is even buildable, let alone publishable | N/A (internal testing can use a debug build) | Required to publish | One-time developer registration fee |
| An Apple Developer Program membership | Required to publish the iOS app, and for real APNs push | N/A | Required to publish | Annual membership fee |

## Summary: hard blockers vs. soft gaps

**Cannot do ANY real staging deployment without**: a host, a domain +
DNS + TLS, and at least one real AI provider key. Everything else in this
document can be deferred (with the specific feature it gates staying
disabled/untested) without blocking a first staging deployment.

**Cannot claim production-ready without**, additionally: a real Redis
instance (once more than one app process exists), S3-compatible storage
(once more than one instance or an ephemeral filesystem is involved), a
real Stripe account (if billing is live), real OAuth app credentials (if
those integrations are offered), and genuine load testing on real
infrastructure (before making any capacity claim to anyone outside this
team).
