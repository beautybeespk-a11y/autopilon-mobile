# Launch Blockers

Every remaining item that stands between this codebase and real
customers, prioritized. Nothing here is classified as a blocker just
because it's an optional future feature — see each section's own
reasoning.

- **P0 — Must fix before any real customer use.** Not "nice to have
  before launch" — actually broken or actually missing for the platform
  to function safely with a paying customer's data or money.
- **P1 — Must fix before public launch.** Fine for a closed
  beta/design-partner rollout; not fine to open to the general public.
- **P2 — Should fix before scale.** Real gaps that get more expensive to
  ignore as usage grows, but don't block a controlled early launch.
- **P3 — Future improvement.** Genuinely optional; listed so it isn't
  forgotten, not because it's blocking anything.

## P0 — Must fix before any real customer use

1. **No real hosting is provisioned.** The application is real,
   deployable, and tested (see `PRODUCTION_READINESS.md`), but it is not
   running anywhere a real user could reach it. Nothing else on this list
   matters until this exists. See `EXTERNAL_INFRASTRUCTURE.md` and
   `PRODUCTION_COST_ESTIMATE.md`.
2. **No real domain + DNS + TLS is provisioned.** Same category as
   above — `CLIENT_ORIGIN`/`APP_BASE_URL`/OAuth redirect URIs/webhook
   endpoints all need a real, stable HTTPS URL.
3. **No real AI provider key is configured anywhere this has run.** The
   entire product is an AI agent platform; without a real key, no agent
   execution or chat message can ever succeed. `config/env.js` already
   warns loudly at boot if this is missing in production — it will not
   fail silently, but it will fail completely.
4. **Transactional email does not exist.** Password reset and team
   invites currently have no real delivery mechanism at all — this is a
   missing feature, not an untested one (`routes/organizations.js` and
   `routes/auth.js` both explicitly have no outbound-email path). A real
   customer who forgets their password or is invited to a team has no
   way to complete either flow.
5. **No real OAuth account has ever completed the full connect →
   authorize → callback → token storage → refresh → disconnect cycle.**
   Every piece of this is implemented and tested at the code level
   (encryption, CSRF, revocation, cross-org isolation — see
   `PHASE18_2_NOTES.md`), but zero real Google or Meta accounts have ever
   exercised it. A first real customer connecting Gmail or Meta Ads would
   be the first real end-to-end test of this flow.
6. **No real Stripe event has ever been received.** Billing code is
   reviewed and correct (real signature verification, real idempotency,
   correct retry semantics), but has never processed a real webhook, a
   real payment, or a real subscription change. Turning on live billing
   before this is tested is a direct path to charging a real customer
   incorrectly with no verification it would work.

## P1 — Must fix before public launch

7. **No developer webhook has ever been delivered to a real external
   endpoint.** The code path (signing, replay protection, retry/backoff,
   SSRF protection) is real and regression-tested up to the point of an
   actual outbound network call — genuinely attempted this phase and
   blocked by this sandbox's own network egress policy, not by the code.
   Needs one real test from an environment with normal internet access
   before offering this feature to real developers.
8. **No mobile build has ever been produced.** No Flutter SDK exists
   anywhere this project has been built; `android`/`ios` platform folders
   are not fully scaffolded. Blocks any mobile app store submission or
   real-device testing.
9. **External error tracking/alerting is not integrated.** Real
   structured logging exists and is genuinely useful input for one
   (Phase 18.5), but nothing pages anyone on a real production outage
   today. Acceptable for a closed beta with active human monitoring; not
   acceptable once the team can't watch logs continuously.
10. **`SESSION_STORE=redis` fails closed on a Redis outage** (by
    deliberate design — see `PHASE19_NOTES.md`). This is documented,
    correct behavior for a security-relevant failure mode, but it means a
    production deployment choosing Redis-backed sessions needs Redis
    itself to be genuinely highly available (managed HA, Sentinel,
    Cluster) — a plain single-instance Redis is a real single point of
    failure for all authenticated traffic. Not a code bug; an
    infrastructure requirement that needs to be actually met, not just
    known about.
11. **No scheduled/automated database backup exists yet.** The
    backup/restore mechanism itself is real, tested, and verified
    end-to-end in Phase 19 (including a real restore → boot → login
    cycle) — but nothing currently runs `npm run backup` on a schedule.
    Needs a real cron/scheduler wired up in whatever hosting environment
    is chosen.

## P2 — Should fix before scale

12. **No continuous database replication (Litestream) is configured.**
    The scheduled-snapshot backup mechanism gives an RPO of "time since
    last backup," not continuous — fine for an early launch, worth
    tightening before the cost of losing recent data grows with real
    usage.
13. **Object storage is local-disk by default.** `STORAGE_PROVIDER=s3`
    is fully implemented and real (Phase 14), but the default is local
    disk, which is wrong the moment the deployment runs more than one
    instance or an ephemeral filesystem. Needs to be switched over before
    horizontal scaling or a platform migration.
14. **No load testing against real production-scale infrastructure or a
    production-sized dataset has been performed.** Phase 18.8/19's
    numbers are real but explicitly single-process, sandboxed,
    near-empty-database measurements — useful for catching regressions,
    not for a real capacity claim to anyone outside the team.
15. **No full application-rollback rehearsal has been performed** (an
    OLD binary running against a database a NEWER version already wrote
    to). The additive-schema-safety argument is real and verified by
    source audit (Phase 19), but has not been rehearsed as an actual
    deploy-old-version-back drill.
16. **User account self-deletion does not exist.** Only org deletion is
    implemented. Likely a real requirement for some jurisdictions'
    privacy regulations before a genuinely public launch with those
    users — worth confirming against actual legal requirements for the
    target market, not assumed here.
17. **Docker build has never actually been run.** `Dockerfile`/
    `docker-compose.yml` are syntax-reviewed and `docker compose config`-
    validated, but no Docker daemon has ever been available to actually
    build or run them in any sandbox this project has used. Should be
    built and run for real at least once before being trusted for a real
    deployment, even though it's not the only viable deployment path
    (a plain `node index.js` on a VM works too).

## P3 — Future improvement

18. **No cost-visibility/margin dashboard exists** beyond the existing
    per-org AI spend limits. Not blocking — the spend limits themselves
    are the real safety mechanism; a dashboard would just make the
    numbers easier to see.
19. **`RedisQueueProvider` is real and tested but not wired into the live
    job-processing path.** Only relevant if a genuinely multi-machine (not
    just multi-process) job-processing topology is ever needed — the
    current WAL-mode-SQLite-plus-multiple-`worker.js`-processes approach
    is real, tested (including a hard-kill durability test in Phase 19),
    and sufficient for a single-database deployment.
20. **CDN in front of static assets / object storage is not configured.**
    Would reduce origin load and possibly egress cost at real scale; not
    needed at launch.
21. **No zero-downtime deployment has been measured.** Graceful shutdown
    and readiness/liveness separation are real and code-reviewed;
    measuring actual zero-downtime behavior needs a real load
    balancer/orchestrator in front of more than one instance.

## What is explicitly NOT a blocker

For clarity, since the phase instructions warn against over-classifying:
the following are real, working, and tested — not listed above because
they are not blockers:

- OAuth token encryption at rest, OAuth CSRF protection, OAuth disconnect
  revocation (code level), tenant isolation, security headers, CORS,
  reverse-proxy/session security, audit logging, admin panel access
  control, the Public API and both SDKs, idempotency handling, rate
  limiting, the WooCommerce credential-security fix, and the full 190-check
  sandbox regression suite (verified fresh in Phase 19, and separately on
  a real GitHub Actions runner).
- The three real bugs found and fixed via Phase 19's own chaos testing
  (liveness hanging on a Redis outage, stack-trace leaks on an unhandled
  error, the rate limiter failing closed) are fixed, not listed as
  blockers — they're mentioned in the P1 Redis-HA item above only because
  the underlying *choice* to use `SESSION_STORE=redis` still needs real
  infrastructure (HA Redis) to be fully safe, not because the code itself
  has an outstanding gap.

See `PHASE19_NOTES.md` for the full completion report and exact test
counts behind every claim above.
