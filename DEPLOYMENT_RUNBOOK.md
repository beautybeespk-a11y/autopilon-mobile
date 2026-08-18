# Deployment Runbook

Exact procedures for deploying Autopilon to a real staging or production
environment. This runbook has **not been executed against a real target**
(no hosting infrastructure available in this sandbox) — it is internally
consistent with everything built and tested in Phase 18, but treat the
first real run of it as a rehearsal, not a guarantee.

## 1. Prerequisites

Before starting, have ready (see `EXTERNAL_INFRASTRUCTURE.md` for the
full list and why each is needed):
- A host (VM/container platform) that can run a long-lived Node process.
- A domain, with DNS pointed at the host, and TLS provisioned (Let's
  Encrypt or your platform's own).
- At least one real AI provider API key (Anthropic/OpenAI/Gemini).
- For anything beyond a single-instance deployment: a real Redis instance.
- For anything beyond a single-instance or ephemeral-filesystem
  deployment: an S3-compatible object storage bucket.

## 2. Environment variables

Copy `.env.example` and fill in real values. At minimum for production:

```bash
NODE_ENV=production
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
BYOK_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
CLIENT_ORIGIN=https://your-real-domain.example.com
APP_BASE_URL=https://your-real-domain.example.com
PLATFORM_ADMIN_EMAIL=you@example.com
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<real key>
DB_PATH=/path/to/a/persistent/volume/app.sqlite
```

**Never commit this file.** Set these in your hosting platform's own
secret manager. `server/config/env.js` will refuse to boot if
`SESSION_SECRET`/`BYOK_ENCRYPTION_KEY` are missing or weak — this is
intentional, not a bug to work around.

If running more than one app process (horizontal scaling, or app+worker
as separate processes):

```bash
REDIS_URL=redis://<your-redis-host>:6379
CACHE_PROVIDER=redis
RATE_LIMIT_PROVIDER=redis
SESSION_STORE=redis
```

If the filesystem isn't guaranteed to persist or be shared across
instances:

```bash
STORAGE_PROVIDER=s3
S3_BUCKET=<your-bucket>
S3_REGION=<your-region>
S3_ACCESS_KEY_ID=<...>
S3_SECRET_ACCESS_KEY=<...>
```

## 3. Reverse proxy / load balancer configuration

**Critical, found the hard way in Phase 18.11**: if the app sits behind
any TLS-terminating reverse proxy (nginx, your platform's own load
balancer, Cloudflare, etc. — true for virtually every real deployment),
the proxy must forward the `X-Forwarded-Proto` header, and `index.js`
already calls `app.set("trust proxy", 1)` in production to trust exactly
one such hop. If your topology has more than one proxy hop in front of
the app (e.g., a CDN in front of a load balancer), adjust the `1` to the
correct hop count — see [Express's trust proxy
docs](https://expressjs.com/en/guide/behind-proxies.html). Getting this
wrong means the session cookie is silently never set and nobody can log
in — verify this specifically after deployment (see Step 8).

## 4. Database setup

No separate database server to provision — SQLite lives at `DB_PATH`
(a mounted persistent volume, not the container's own ephemeral
filesystem). On first boot, `db.js` creates the schema automatically
(idempotent `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE ADD COLUMN`
statements) — there is no separate migration command to run.

## 5. Storage setup

If using local storage (`STORAGE_PROVIDER=local`, the default): mount a
persistent volume at `server/uploads/files/` — same reasoning as the
database, don't let this live on the container's ephemeral filesystem.

If using S3: create the bucket ahead of time; no bucket-provisioning code
exists in this app (the storage provider assumes the bucket already
exists and has the right permissions for the credentials provided).

## 6. Queue / worker setup

The default (`QUEUE_PROVIDER=in_process`) works with zero extra setup —
`index.js`'s inline job processor runs automatically. For dedicated
worker processes (recommended once job volume matters):

```bash
# On the API server:
RUN_INLINE_JOB_PROCESSOR=false

# As one or more separate processes/containers, same DB_PATH mounted:
node worker.js
```

Both are real, tested (Phase 18.3) — multiple `worker.js` processes
sharing one SQLite file via WAL mode correctly split job load with zero
duplication, verified with a real multi-process test.

## 7. Domain, SSL, OAuth callback, webhook configuration

1. Point DNS at your host/load balancer; provision TLS.
2. **Google OAuth** (if using Gmail/Calendar/Drive/Docs/Sheets): register
   `https://<your-domain>/api/integrations/gmail/callback` (and the
   derived per-service callback paths — see `integrations/google/
   oauth.js`) as Authorized redirect URIs in your Google Cloud OAuth
   client. Set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
   `GOOGLE_REDIRECT_URI`.
3. **Meta OAuth** (if using Ads/WhatsApp): register
   `https://<your-domain>/api/integrations/meta/callback` in your Meta
   app's OAuth settings. Set `META_APP_ID`/`META_APP_SECRET`/
   `META_REDIRECT_URI`.
4. **Stripe webhook** (if billing is live): create an endpoint at
   `https://<your-domain>/api/stripe/webhook` in the Stripe dashboard,
   listening for `checkout.session.completed`, `customer.subscription.
   updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`. Set `STRIPE_SECRET_KEY`/
   `STRIPE_WEBHOOK_SECRET`.
5. See `PHASE18_10_OAUTH_BILLING_ADMIN_REVIEW.md` for the exact
   step-by-step OAuth testing procedure once credentials exist.

## 8. Initial deployment

```bash
# Build
npm --prefix server install
npm --prefix client install
npm --prefix client run build   # produces client/dist, served by the API server

# Verify configuration BEFORE going live
node -e "process.env.NODE_ENV='production'; import('./server/config/env.js').then(m => m.validateEnv({ exitOnFailure: true }))"

# Start
NODE_ENV=production node server/index.js
```

Or via Docker (`Dockerfile`/`docker-compose.yml` — **syntax-reviewed, not
build-tested in this sandbox**; do a real `docker compose up --build` in
an environment with a Docker daemon before relying on this path):

```bash
cp .env.example .env   # fill in real values
docker compose up --build
```

## 9. Health verification

```bash
curl https://<your-domain>/api/health/live    # {"ok":true} — process is up
curl https://<your-domain>/api/health/ready   # {"ok":true} — DB is reachable
```

Then, as a platform admin (log in first):

```bash
curl -b <admin-session-cookie> https://<your-domain>/api/health/          # full rollup
curl -b <admin-session-cookie> https://<your-domain>/api/health/redis     # if Redis is configured
curl -b <admin-session-cookie> https://<your-domain>/api/health/queue     # real enqueue+process self-test
```

**Verify the trust-proxy fix specifically**: sign up a real test account
through the real domain (browser, not curl with a manually-forwarded
header) and confirm you stay logged in on the next page load. This is the
one thing that silently breaks if the reverse proxy config from Step 3 is
wrong, and it will not show up as an error anywhere — it just looks like
login doesn't "stick."

## 10. Backup verification

Immediately after the first successful deployment:

```bash
cd server
npm run backup -- --compress
```

Confirm the script reports `"ok": true` with a real row-count comparison
against the source, then **actually test a restore** against a
non-production copy before trusting this as a real safety net — see
`BACKUP_RESTORE.md` for the full real backup→corrupt→restore→verify cycle
this was tested with in this sandbox (on a small test dataset; re-run it
against production-sized data once you have some).

Schedule `npm run backup` on a real cron/scheduler — nothing in this repo
runs it automatically. For a real RPO better than "time since last
scheduled backup," set up Litestream (see `BACKUP_RESTORE.md`).

## 11. Rollback procedure

- **App code**: redeploy the previous known-good build/image. No
  database migration framework exists to "roll back" — schema changes in
  this app are additive (`ALTER TABLE ADD COLUMN`, never drops/renames),
  so an old app version running against a newer database schema is safe
  (it simply ignores columns it doesn't know about).
- **Database**: if a bad deploy corrupted or wrote bad data, restore from
  the most recent verified backup: `npm run restore -- <backup-file>
  --force` (makes a safety copy of the current file first — see
  `BACKUP_RESTORE.md`).
- **Worker processes**: stop and redeploy independently of the API
  server — they share no in-memory state, only the SQLite file.
- **Feature flags**: existing Phase 16 feature-flag system can disable a
  specific capability without a full redeploy — use this for anything
  flag-gated before reaching for a full rollback.
- **Emergency stop**: existing Phase 16 maintenance-mode switch
  (`POST /api/admin/maintenance`) takes the app read-only or fully down
  for non-admins without a redeploy.

Phase 19 verified the two pieces this sandbox genuinely can rehearse for
real: a clean-checkout-to-running deployment (a separate `git clone` of
this exact branch → `npm ci` → build → fresh-DB migrate → boot → health
check → 24/24 real regression suite, all reproduced successfully) and a
real backup → restore → boot → login cycle (not just an integrity check —
a real user logged into a real server booted against the restored
database). A full **rollback** rehearsal — deploying an OLD version
against a database a NEWER version already wrote to, confirming it still
works — was not performed this phase (git-based code rollback and the
additive-migration-safety argument above are both real, but "an old
binary running against new-shaped data" is still worth a deliberate first
rehearsal against real staging, not assumed from the schema-additivity
argument alone). Multi-instance rollback (blue/green, canary) needs real
hosting with more than one instance, which this sandbox doesn't have.

## 12. Staging test runbook (Phase 18.1 §17)

The exact 18-step checklist for the remaining real-environment tests this
sandbox cannot perform. Each step names what "done" looks like; steps
marked **EXTERNAL** need a real credential/service this environment has
never had access to — see `EXTERNAL_INFRASTRUCTURE.md` for what to
provision. Steps marked **(regression suite)** reference commands added
by Phase 18.1, run from `server/` against the live staging URL.

1. **Deploy staging** — follow Steps 1–8 above against real staging
   infrastructure (not this sandbox).
2. **Configure environment variables** — Step 2 above; use a *staging*
   `SESSION_SECRET`/`BYOK_ENCRYPTION_KEY` distinct from production's.
3. **Configure database** — Step 4 above; confirm the persistent volume
   survives a container restart before trusting it.
4. **Configure Redis** — `REDIS_URL`, `CACHE_PROVIDER=redis`,
   `RATE_LIMIT_PROVIDER=redis`, `SESSION_STORE=redis` if staging runs more
   than one app process; verify with `GET /api/health/redis`.
5. **Configure storage** — `STORAGE_PROVIDER=s3` + bucket credentials if
   staging's filesystem isn't guaranteed persistent; otherwise confirm the
   local `uploads/` volume persists across a restart.
6. **Configure OAuth** **(EXTERNAL)** — real Google Cloud OAuth client and/or
   Meta developer app, redirect URIs registered per Step 7 above.
7. **Configure Stripe test mode** **(EXTERNAL)** — a real Stripe account in
   TEST mode, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` set.
8. **Configure email** — **NOT APPLICABLE YET**: no transactional email
   provider is integrated in this codebase at all (`routes/
   organizations.js`'s invite flow and `/auth/forgot-password` both have
   no outbound email path — see `PHASE18_1_NOTES.md` §5). Nothing to
   configure until that's built; don't skip past this thinking it's
   already working.
9. **Configure webhook endpoint** **(EXTERNAL)** — register a real receiving
   endpoint (e.g. `webhook.site` for a first smoke test, or a real
   subscriber) against a developer webhook created via
   `POST /api/v1/webhooks`.
10. **Configure domain/SSL** — Step 7.1 above; confirm `https://` resolves
    and the certificate is valid before testing anything else.
11. **Run health checks** — `curl https://<staging>/api/health/live` and
    `/ready`; as a platform admin, `/api/health/`, `/api/health/redis`,
    `/api/health/queue` (Step 9 above).
12. **Run security suite (regression suite)** —
    `npm run test:security -- https://<staging>` and
    `npm run test:security:public-api -- https://<staging>` from
    `server/`. Both must be 24/24 and 30/30 as they were in this sandbox
    (Phase 18.1 §14) — a real staging run is the first time these execute
    against infrastructure this sandbox never had (a real reverse proxy,
    real TLS, possibly real Redis).
13. **Run OAuth test** **(EXTERNAL)** — the manual step-by-step account
    connect/refresh/disconnect walkthrough in
    `PHASE18_10_OAUTH_BILLING_ADMIN_REVIEW.md`, against a real Google/Meta
    account. `npm run test:csrf -- https://<staging>` (7/7 expected) and
    `npm run test:oauth-revocation` (11/11 expected, in-process — doesn't
    need staging, just the app's own code) can run automatically first to
    confirm the state-token and revocation mechanics are intact before
    doing the manual walkthrough. On the manual walkthrough's disconnect
    step, specifically confirm the app now appears removed from Google's
    "Third-party apps with account access" page (myaccount.google.com/
    permissions) or Meta's "Apps and Websites" settings — this app calls
    the real revoke endpoint on disconnect (Phase 18.2), but that call has
    never been confirmed against a live account in this sandbox.
14. **Run billing test** **(EXTERNAL)** — Stripe TEST mode checkout,
    upgrade/downgrade/cancel, and a real webhook delivery from Stripe's
    dashboard "Send test webhook" feature; confirm `activity_logs` records
    each transition and `subscriptions`/`invoices` update correctly.
15. **Run webhook test** **(EXTERNAL, regression suite)** — create a real
    developer webhook, trigger an event (e.g. create a task via the
    Public API), confirm real delivery, correct HMAC signature, and retry
    behavior on a deliberately-failing endpoint. Complements (does not
    replace) the code-level checks already covered by
    `npm run test:security:public-api -- https://<staging>`'s webhook
    signing/replay/SSRF checks.
16. **Verify logs (regression suite)** — `npm run test:production-logging
    -- https://<staging> <path-to-staging's-real-log-output>` (4/4
    expected); separately, manually grep staging's real log aggregator for
    the test account's password used above — confirm it never appears.
17. **Verify monitoring** **(EXTERNAL)** — confirm whatever uptime/error
    tracking service was provisioned (see `EXTERNAL_INFRASTRUCTURE.md`'s
    Monitoring section — none is integrated by default) actually receives
    an event; deliberately trigger a 500 and confirm it's captured.
18. **Verify rollback** — actually perform Step 11's rollback procedure
    once, against staging, before trusting it applies to production.

Also worth running once staging exists, even though not in the spec's
original 18: `npm run test:credential-leakage`, `npm run test:reverse-proxy
-- proxy <staging-url>` (verifies the real reverse-proxy trust-boundary
behavior against staging's actual proxy, not this sandbox's simulation),
`npm run test:data-retention` (safe — it seeds and deletes its own
fixture org, doesn't touch anything else), and `npm run test:admin-panel
-- https://<staging>` (needs `PLATFORM_ADMIN_EMAIL` set to a real
throwaway staging admin account).

Phase 18.2 added six more, none of which need staging infrastructure —
they're safe to run against `localhost` at any time, including in CI —
but worth running once against staging too, since they exercise the real
database/queue/encryption stack rather than a simulation of it:
`npm run test:oauth-revocation` (11/11), `npm run test:queued-job-credential-safety`
(4/4), `npm run test:token-refresh-safety` (7/7), `npm run test:reconnect-isolation`
(15/15), `npm run test:audit-api-response` (5/5), and
`npm run test:failure-concurrency` (9/9).

Phase 19 added four more, same story — no staging infrastructure needed,
safe to run against `localhost` or CI at any time, but genuinely worth
running once against real staging too: `npm run test:worker-crash-reclaim`
(5/5), `npm run test:db-migration` (4/4, though this one is most useful
run against a copy of a real pre-existing staging database rather than
the synthetic fixture it builds by default — see the test file's own
comments), `npm run test:multi-worker-real-process` (4/4, spawns two real
`node worker.js` processes and hard-kills one — needs the ability to spawn
child processes, which a serverless/managed-container platform may not
allow the same way a VM does), and `npm run test:redis-outage-failsafe`
(3/3, spawns and kills a real `redis-server` — same caveat, and doubly
useful to re-run against staging's actual managed Redis if the platform
allows temporarily blocking network access to it, since a managed Redis
can't be `SIGKILL`ed the way this test's local one is).

## 13. Phase 19 additions — real chaos/durability findings and CI changes

Three real bugs were found via genuine failure/chaos testing this phase
(spawn a real `redis-server`, boot the app pointed at it with every
Redis-backed provider active, then `SIGKILL` Redis mid-run) — all fixed,
all covered by `npm run test:redis-outage-failsafe`:

1. **`/api/health/live` used to hang during a Redis outage** instead of
   responding instantly, because session middleware (which touches Redis
   on every request) ran before health routes. Fixed by mounting
   `/live`+`/ready` before session/rate-limit middleware entirely — verify
   this specifically after any future middleware-ordering change in
   `index.js`, since it's easy to accidentally reintroduce.
2. **Unhandled Redis errors used to leak a raw stack trace** (including
   real server file paths) via Express's default error page. Fixed with a
   global JSON error handler at the end of `index.js` — verify any new
   route still gets a clean JSON error on an unexpected throw, not HTML.
3. **The global rate limiter used to fail CLOSED on a Redis error**,
   meaning a Redis blip took down 100% of `/api/*` traffic. Fixed to fail
   OPEN (logged as degraded). If `RATE_LIMIT_PROVIDER=redis` is used in
   staging/production, expect a brief window of unenforced rate limits
   during any real Redis incident — this is the intended, safer trade-off,
   not a bug, but worth knowing before it happens for the first time on
   call.

A worker-crash job reclaim gap was also found and fixed: a `worker.js`
process that crashes (not a graceful `SIGTERM`) mid-job used to leave
that job stuck at `status='running'` forever. Fixed with a stale-job
reclaim sweep (`JOB_STALE_TIMEOUT_MS`, default 10 minutes) — if a real
staging/production job legitimately takes longer than that to run, raise
this env var, or the job will be reclaimed and retried while still
genuinely in progress.

The CI pipeline (`.github/workflows/ci.yml`) was expanded from 4 to all
20 regression suite files, given a `workflow_dispatch` trigger so it can
be run manually on any branch (not just on push/PR to `main`), and
**actually fired against a real GitHub Actions runner** three times this
phase — not just dry-run locally. The first real run caught a genuine
CI-only bug (`BYOK_ENCRYPTION_KEY` wasn't propagated to a test step that
needed it — GitHub Actions steps don't share inline `run:` env vars the
way one continuous local shell session does) that no amount of local
dry-running would have found. If you add a new regression suite to this
repo, add it to `ci.yml` too and actually fire the workflow at least once
(`gh workflow run ci.yml --ref <branch>` or the GitHub UI's "Run
workflow" button) rather than trusting a local pass alone.
