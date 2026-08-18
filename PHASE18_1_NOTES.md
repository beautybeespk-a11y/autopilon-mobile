# Phase 18.1 — Production Security & Real-Environment Hardening

Completion report for the focused hardening pass that followed Phase 18's
production infrastructure build-out. This phase touched no product
features and made no unrelated refactors — every change below was a
security/correctness fix found during a targeted review, made with the
smallest safe diff, and verified with a real regression test before being
committed.

**Classifications used, exactly as specified for this phase:**
- **IMPLEMENTED + TESTED** — real code, real test, actually passing in
  this environment.
- **IMPLEMENTED + EXTERNAL TEST REQUIRED** — the code is real and
  reviewed/tested as far as this sandbox can reach, but a final check
  needs a real external credential or service this sandbox has never had.
- **CONFIGURATION READY** — nothing left to build; only real
  credentials/infrastructure stand between this and a working staging
  test.
- **NOT READY** — a real, known gap exists and was not fixed this phase
  (documented below, with why).
- **PRODUCTION BLOCKER** — must be resolved before real users/real
  credentials touch this system.

---

## 1. OAuth/Integration Token Encryption at Rest — IMPLEMENTED + TESTED

**Was the #1 priority for this phase, and the most significant fix.**
`accessToken`/`refreshToken` on the `integrations` table — OAuth tokens
and manual credentials alike (a WooCommerce consumer secret, a WordPress
application password, a Shopify manual token) — are now AES-256-GCM
encrypted before they ever touch the database, using the existing
`orchestrator/secretsCrypto.js` primitive (already used for BYOK provider
keys and webhook signing secrets — no new crypto invented).

Decryption is centralized in `integrations/manager.js`'s three read
functions (`getConnection`/`getOrgConnection`/`listOrgConnections`), so
every one of the 12+ existing call sites that reads `.accessToken` off a
connection row (Gmail, Google service tokens, WhatsApp, Shopify,
WooCommerce, WordPress health checks, `requireValidToken()`,
`connectionHealth()`) works completely unchanged — by the time any of
them see a connection row, its tokens are plaintext again. One caller
that bypasses `manager.js` entirely (`integrations/whatsapp/services/
ownerLookup.js`, which looks up a userId *from* a phoneNumberId, the
reverse of what `getConnection()` needs) got its own matching decrypt
logic.

**Migration**: a decrypt failure — wrong key, corrupted ciphertext, or an
old plaintext value from before this change (not even in the expected
`iv:authTag:ciphertext` format) — is caught and logged (provider name +
error message only, never the value) and returns `null`, which the
existing `connectionHealth()` already treats as "not connected." Old
connections simply prompt reconnect the next time they're used. This
schema has never had real production users, so no data-migration risk
exists beyond that.

**Testing**: 27 real assertions (`test-oauth-encryption.mjs`, run via a
live DB) — encrypt/store/read/decrypt, refresh preserving the untouched
refresh token via `COALESCE`, disconnect clearing cleanly, invalid
ciphertext degrading to `null` not a crash, wrong encryption key both
throwing directly (`decryptSecret`) and degrading safely through the real
app path (`getConnection`), and cross-org isolation (two orgs' secrets
decrypt correctly and distinctly; raw ciphertexts differ; neither raw
value contains the plaintext as a substring).

**Bonus fix found in the same pass**: `routes/orgIntegrations.js`'s
generic org-level manual-provider connect handler was picking the wrong
field as WooCommerce's "secret" (`consumerKey` instead of
`consumerSecret`) and copying the *entire* raw request body — including
the real secret — into the `meta` JSON column in plaintext, for
WordPress/WooCommerce/Shopify alike, bypassing the encrypted column
entirely. Fixed to mirror the already-correct personal-connection routes.

---

## 2. OAuth/Credential Leakage Audit — IMPLEMENTED + TESTED

Grepped every `res.json()` call for token field names, enumerated every
caller of `getConnection`/`getOrgConnection`/`listOrgConnections` and
manually verified each one's actual HTTP response shape, reviewed every
integration `api.js` file's error-construction code, and reviewed every
Admin Panel route/service for accidental token exposure.

**Found and fixed one real leak vector**: `integrations/woocommerce/
api.js` sent the consumer key/secret as URL query parameters on every
request — including over HTTPS. That's a real risk (the secret ends up
in the destination store's own server access logs, CDN logs, and any
`Referer` header, none of which are under this app's control).
WooCommerce's own REST API docs recommend HTTP Basic Auth over HTTPS
specifically to avoid this. Fixed: over HTTPS, the credentials now go in
an `Authorization: Basic` header; the query-string fallback is kept only
for plain-HTTP stores (WooCommerce doesn't support Basic Auth without
SSL).

**Confirmed clean, no change needed**: every integration's error
messages (Gmail, WhatsApp, Shopify, WordPress) surface only the
provider's own error text or a generic status code, never a header or
token value; the Admin Panel has zero references to `accessToken`/
`refreshToken` anywhere; developer webhook payloads (every
`publishDeveloperWebhookEvent()` call site) pass only ids, names, and
error messages, never a connection object; the JS/Python SDKs are thin
Public API passthroughs with no token-specific handling of their own.

**Testing**: new permanent suite `test/credentialLeakageRegression.js`
(8 checks) — seeds real personal and org-level connections, asserts the
secret never appears in any HTTP response body, raw DB column, `meta`
JSON, or activity-log description; verifies disconnect leaves no stale
ciphertext; verifies the WooCommerce fix via a captured outbound request.

---

## 3. OAuth Real-Account Staging Test — IMPLEMENTED + EXTERNAL TEST REQUIRED

The encryption, leakage, and CSRF fixes above are all real and tested as
far as this sandbox can reach without live provider credentials. The
actual end-to-end flow — real consent screen, real callback, real token
refresh against Google's/Meta's servers — has never been exercised, since
no real OAuth app credentials exist here.

**EXTERNAL STAGING TEST REQUIRED.** Exact steps: provision a real Google
Cloud OAuth client and/or Meta developer app (see
`EXTERNAL_INFRASTRUCTURE.md`), set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_
SECRET`/`GOOGLE_REDIRECT_URI` or `META_APP_ID`/`META_APP_SECRET`/`META_
REDIRECT_URI`, then walk through connect → authorize → callback → token
storage → an actual API call using the connection → expired-token
handling → disconnect → reconnect → verify a second org's connection is
unaffected. `npm run test:csrf` can run first against staging (no real
provider needed) to confirm the state-token mechanics are intact before
the manual walkthrough.

---

## 4. Stripe/Billing Staging Test — IMPLEMENTED + EXTERNAL TEST REQUIRED

Unchanged this phase — re-confirmed via code review that the existing
implementation (Phase 18.10) is still correct: real signature
verification via Stripe's own SDK, real idempotency, correct retry
semantics. Never received a real event, since no Stripe account exists
in this sandbox.

**EXTERNAL STAGING TEST REQUIRED.** A real Stripe account in TEST mode,
webhook endpoint registered at `<APP_BASE_URL>/api/stripe/webhook`,
`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` set. Exact checklist in
`DEPLOYMENT_RUNBOOK.md` §12 step 14: customer creation, subscription
create/update/upgrade/downgrade/cancel, a real successful and a real
failed payment, webhook signature verification against a genuine Stripe
event, duplicate-webhook idempotency, quota/usage sync, admin billing
status reflecting the change.

---

## 5. Transactional Email Test — NOT IMPLEMENTED

**No transactional email provider is integrated anywhere in this
codebase.** `routes/organizations.js`'s member-invite flow and
`routes/auth.js`'s `/forgot-password` both explicitly have no outbound-
email path — invited users are told out-of-band today, and forgot-
password returns a generic acknowledgment with no email actually sent.
This is a missing feature, not an untested one. There is nothing to
stage-test until it's built; that build is out of this hardening phase's
scope (it's a new feature, not a fix). Documented here so it's never
silently assumed to already work.

---

## 6. Real Webhook Delivery Test — IMPLEMENTED + EXTERNAL TEST REQUIRED

Signing, timestamp/replay protection, SSRF protection on webhook
creation, and retry/backoff logic are all real and covered by the Public
API security regression suite (5 dedicated webhook-signing/SSRF checks,
part of the 30/30 total). Never delivered to a real, independently-
reachable external endpoint outside this sandbox.

**EXTERNAL STAGING TEST REQUIRED.** Checklist in `DEPLOYMENT_RUNBOOK.md`
§12 step 15: create a real developer webhook, trigger a real event
(e.g., create a task via the Public API), confirm real delivery with a
correct HMAC signature and timestamp, verify retry/exponential backoff
and dead-letter behavior against a deliberately-failing receiver, confirm
duplicate-delivery/replay protection holds under real network conditions.

---

## 7. Reverse-Proxy/Session Verification — IMPLEMENTED + TESTED

Dedicated regression pass for the Phase 18 `trust proxy` fix, run in both
configurations. New suite `test/reverseProxyRegression.js`, 7 checks
total:

- **Outside production** (2/2): a spoofed `X-Forwarded-For` claiming a
  fresh fake IP on every request still hits the real rate limit (proxy
  headers are not blindly trusted without explicit configuration);
  `X-Forwarded-Proto: https` does not mark the cookie `Secure` outside
  production.
- **In production, behind the trusted hop** (5/5): the cookie's `Secure`
  flag genuinely depends on the trusted signal — present when the
  trusted proxy reports `https`, and when that signal is absent, the
  session cookie is not sent **at all** (a real, previously-unverified
  fail-safe in `express-session`'s `cookie.secure: true` behavior — not a
  silent downgrade to an insecure cookie); login/session persistence/
  logout all work correctly across the trusted-proxy path; distinct real
  clients behind the same proxy get independent rate-limit buckets.

**Documented, not "fixed"**: a client connecting directly (bypassing the
real proxy) can spoof its own `X-Forwarded-For` when `trust proxy: 1` is
set — this is inherent to Express's numeric trust-proxy configuration,
not a code defect, and it's exactly why a production deployment must keep
this process unreachable except through the configured proxy.

---

## 8. CSRF Security Regression — IMPLEMENTED + TESTED

New suite `test/csrfRegression.js`, 7/7 checks, exercising the Phase 18
`secureRandomToken()` fix (`crypto.randomBytes`, replacing the old
`Math.random()`-backed `state` generation in Gmail/Meta/Google-services
OAuth flows): fresh 64-hex-char state on every `/connect` call, garbage
or missing state rejected, the correct state accepted, single-use
(replay of an already-consumed state rejected — not just checked against
a static value), cross-user isolation (state is session-scoped), and
correct behavior when a second `/connect` call in the same session
invalidates the first call's now-stale state.

---

## 9. Data Retention / Orphaned File Regression — IMPLEMENTED + TESTED

Re-verified `deleteOrganization()`'s cascade across every org-scoped
table in the schema — cross-referenced every table with an `orgId`
column against the function's explicit cleanup list and every real
`ON DELETE CASCADE` foreign key.

**Found and fixed one real gap**: `conversations.agentId` had no foreign
key to `agents` at all (every other agent-child table cascades
correctly). Deleting an org's agents left any conversations held with
those agents — and, via `messages`' own cascade to `conversations`, the
actual message content — orphaned rather than deleted. Real chat content
(potentially customer/business data discussed through that org's agent)
could survive indefinitely with a dangling agent reference, disconnected
from any tenant, after the org that owned it was gone. Fixed by deleting
those conversations (which cascades to their messages) before the org's
agents are removed, scoped precisely to that org's own agents — a user's
personal conversations with their own personal agents are untouched.

**Testing**: new suite `test/dataRetentionRegression.js`, 10/10 checks —
builds a full fixture across every org-scoped table including real
"sensitive" message content, calls the real `deleteOrganization()`, and
asserts nothing org-scoped survives (including a direct check that the
sensitive message content is unreadable from any surviving row), while
explicitly confirming `activity_logs` **is** preserved — intentional,
since the audit record of the deletion needs to survive the deletion it's
recording.

---

## 10. Secret & Credential Audit — IMPLEMENTED + TESTED

Full repository scan: common key-format patterns (`sk-`/`sk_live_`/
`sk_test_`/`AKIA`/`ghp_`/`xox*`/`AIza`, PEM private-key blocks),
hardcoded password/secret/apiKey-shaped assignments outside
`process.env` reads, database connection strings with embedded
credentials, and git history for any committed-then-deleted `.env`/
`.pem`/`.key` files.

**One item found, not a defect**: a Firebase client API key committed in
the Flutter app (`google-services.json`, `firebase_options.dart`). This
is Google's own documented, expected pattern for Firebase mobile/web
apps — the key identifies the Firebase project and is not a secret by
itself; real access control comes from Firebase Security Rules and,
optionally, API key restrictions in Google Cloud Console, not from
keeping the value out of version control. Not removed (the mobile app
genuinely needs it shipped client-side). Flagged here as a review item:
**before real users, confirm Firebase Security Rules are actually locked
down**, and consider adding an Android package+SHA-1 restriction on the
key as defense in depth — neither can be verified from this repo alone.

No other secret-shaped value was found anywhere in tracked files or git
history. Per this phase's own instructions, no discovered secret value is
reproduced in this report.

---

## 11. Production Logging Review — IMPLEMENTED + TESTED

Audited all 29 non-test `console.error`/`console.log` call sites in the
server: every one logs only `err.message` or a static string, never a
full error/request object. `config/requestLogging.js`'s access-log
middleware logs only `requestId`/`method`/`endpoint`/`statusCode`/
`latencyMs`/`userId`/`orgId` — never a request body or headers.

**Testing**: new suite `test/productionLoggingRegression.js`, 4/4
checks — a direct unit check of `config/logger.js`'s `redact()` (top-
level and nested `password`/`token`/`secret`/`apiKey`/`Authorization`/
`Cookie` fields stripped, case-insensitively, real values never appearing
in the raw log line), plus a real end-to-end check: signup, a successful
login, and a failed login with a distinctive password against an
already-booted server with stdout/stderr captured to a file — confirmed
that exact password string never appears anywhere in the captured log
output.

---

## 12. Admin Panel Security Review — IMPLEMENTED + TESTED

Reviewed `routes/platformAdmin.js`/`orchestrator/platformAdmin.js` for
auth/role gating, cross-org isolation, audit logging, and credential
exposure. Confirmed: the entire router is gated by a single
`requireAuth, requirePlatformAdmin` — no route-level bypass possible;
unauthenticated requests get 401 (checked before role); a regular user
— including one who owns the org being acted on — gets 403 on every
endpoint; billing/plans/api-usage/organizations responses never contain
an OAuth token, Stripe secret key, or raw/hashed developer API key.

**Found and fixed one real gap**: the admin's "edit a plan's own
pricing/limits" route logged its activity as `"plan_updated"`, but the
billing-audit-log filter only recognized `"plan_changed"` (a different,
pre-existing action — an org owner switching their own org to a
different plan). Every admin edit to a plan's definition was being
recorded correctly in `activity_logs` but never actually surfaced in the
admin's own billing audit view. Fixed by adding `"plan_updated"` to the
filter, with a comment distinguishing the two action names.

**Testing**: new suite `test/adminPanelSecurityRegression.js`, 9/9
checks, requiring a real bootstrapped platform admin (via signup with
`PLATFORM_ADMIN_EMAIL` set — never by writing `isPlatformAdmin=1`
directly to the DB) — covering 10 admin endpoints not yet exercised by
the existing privilege-escalation checks, a credential-leakage pass
across their response bodies, and a direct regression assertion that the
plan-update fix above genuinely surfaces in the billing audit log.

---

## 13. Public API Security Regression — IMPLEMENTED + TESTED

Re-ran the complete Public API security suite after every change this
phase made: **30/30 passing**, unchanged from before this phase — auth,
scopes, tenant isolation, SSRF protection, webhook signing/replay,
quota bypass, feature-flag gating, and secret exposure all still hold.
No working security control was modified to make a test pass.

---

## 14. Full Regression — IMPLEMENTED + TESTED

All 10 regression suites re-run against one freshly booted, freshly
migrated server (plus a second production-mode boot for the reverse-
proxy suite's proxy-mode half, and one standalone run for the data-
retention suite, which needs no HTTP server):

| Suite | Result |
|---|---|
| Security regression (`test:security`) | 24/24 |
| Public API security (`test:security:public-api`) | 30/30 |
| Idempotency (`test:idempotency`) | 10/10 |
| Integration actions (`test:integration-actions`) | 12/12 |
| Credential leakage (`test:credential-leakage`) | 8/8 |
| CSRF (`test:csrf`) | 7/7 |
| Production logging (`test:production-logging`) | 4/4 |
| Admin panel (`test:admin-panel`) | 9/9 |
| Reverse proxy — direct mode | 2/2 |
| Reverse proxy — production/proxy mode | 5/5 |
| Data retention (`test:data-retention`) | 10/10 |
| **Total** | **121/121** |

Two schema/config bugs were found *by* this regression pass, not present
before it, and both are fixed and covered above: the `integrations` table
unique index (`idx_int_user_provider`) predated the `orgId` column and
blocked a user from having both a personal and an org-shared connection
for the same provider — split into two partial indexes; and the
`plan_updated`/`plan_changed` admin audit-log mismatch (§12).

---

## 15. Mobile App Status — CODE READY / EXTERNAL BUILD TEST REQUIRED

**No Flutter build has been performed. Re-confirmed this phase, not
assumed**: `flutter` is not on `PATH` in this sandbox (`command not
found`), and the `android/`/`ios/` platform folders are not fully
scaffolded (`ios/` doesn't exist at all; `android/` has only a partial
`app/` directory) — there is no real build artifact anywhere in this
environment, and none is claimed.

What *was* verified this phase: `AppConfig` (`lib/core/config/
app_config.dart`) resolves dev/staging/production API URLs via
`--dart-define`, with no hardcoded fallback for staging/production (a
staging/production build without an explicit `API_BASE_URL` fails loudly
at startup rather than silently pointing at the wrong host); a grep of
the entire mobile app source for every backend secret name used anywhere
in the server (`ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `BYOK_
ENCRYPTION_KEY`, `SESSION_SECRET`, etc.) found zero matches; the app's
own API client uses cookie-based session auth (matching the web client),
not a hardcoded or embedded token; the one credential-shaped value
present (the Firebase client key) is documented above under §10.

**EXTERNAL BUILD TEST REQUIRED** before any mobile production claim: a
real Flutter toolchain, `flutter create`/scaffold pass on the platform
folders, a real `flutter build`, and a real run on an emulator/device.

---

## 16. Production Secrets Documentation — IMPLEMENTED + TESTED (as documentation)

`EXTERNAL_INFRASTRUCTURE.md` updated with a note on the new
`BYOK_ENCRYPTION_KEY`-based token encryption (no new credential to
provision — reuses the existing key) and the one real staging-cutover
consequence (pre-existing plaintext-token connections prompt reconnect).
Every category in that document is already classified Required/
Recommended/Optional for staging and production separately, and contains
no actual secret values — categories and reasoning only.

---

## 17. Staging Test Runbook — IMPLEMENTED + TESTED (as documentation)

`DEPLOYMENT_RUNBOOK.md` §12 added: the exact 18-step checklist (deploy,
configure env/DB/Redis/storage/OAuth/Stripe test mode/email/webhook
endpoint/domain-SSL, run health checks, run the security suite, run the
OAuth test, run the billing test, run the webhook test, verify logs,
verify monitoring, verify rollback). Steps needing a real external
credential are marked **EXTERNAL**; steps with an automated check
reference the actual `npm run test:*` command and its expected pass
count from this phase's real runs.

---

## 18. Production Readiness Update — IMPLEMENTED + TESTED (as documentation)

`PRODUCTION_READINESS.md` updated: every row this phase changed status
on was reclassified (OAuth token encryption NOT READY → READY, admin
panel re-verified with its fix noted, org deletion cascade updated with
the conversations/messages fix, mobile app re-labeled with this phase's
exact required classification language). A new "External Delivery"
section explicitly classifies transactional email as **NOT IMPLEMENTED**
and developer webhook delivery as **EXTERNAL STAGING TEST REQUIRED**, so
neither can be mistaken for already working.

---

## 19. Testing Standard Followed

Every fix in this phase followed the same eight-step discipline: inspect
the existing implementation, make the smallest safe change, add a real
regression test (never a mock of the fix's own logic), run it targeted,
run the broader suite, verify nothing existing broke, commit with a
message documenting what was tested and how, then move to the next item.
No large unrelated refactor was made anywhere in this phase.

---

## 20. Final Security Gate

| Check | Status |
|---|---|
| OAuth tokens encrypted at rest | ✅ Done, 27/27 assertions |
| Cannot leak through API | ✅ Verified, 8/8 assertions |
| Cannot leak through logs | ✅ Verified, 4/4 assertions |
| Migration handled safely | ✅ Graceful degrade-to-reconnect, verified |
| CSRF security verified | ✅ 7/7 checks |
| Reverse-proxy session behavior verified | ✅ 7/7 checks (both configurations) |
| Data-retention cleanup verified | ✅ 10/10 checks, one real gap found and fixed |
| Secret scan completed | ✅ Full repo + git history, one non-issue flagged |
| Admin security verified | ✅ 9/9 checks, one real gap found and fixed |
| Public API security suite passing | ✅ 30/30 |
| Full regression suite passing | ✅ 121/121 across 10 suites |
| Billing staging status documented | ✅ EXTERNAL STAGING TEST REQUIRED |
| Email staging status documented | ✅ NOT IMPLEMENTED |
| External webhook status documented | ✅ EXTERNAL STAGING TEST REQUIRED |
| Mobile build status documented | ✅ CODE READY / EXTERNAL BUILD TEST REQUIRED |
| Production blockers documented | ✅ See below |

---

## 21. PRODUCTION LAUNCH BLOCKERS

Only items that genuinely prevent a safe launch — everything else above
is either done, or a documented external-test dependency that doesn't
block *code* correctness.

1. **No real OAuth account has ever been tested against this app.**
   Encryption/CSRF/leakage are verified; the actual consent→callback→
   refresh flow against a real Google or Meta account has not. Blocks
   launching any OAuth-based integration until §3's external test is run.
2. **No real Stripe event has ever been received.** Billing code is
   reviewed and correct; it has never processed a real webhook, real
   payment, or real subscription change. Blocks turning on live billing
   until §4's external test is run.
3. **Transactional email does not exist.** Password reset and team
   invites currently have no real delivery mechanism at all. Blocks
   launching to any user who needs to reset a password or receive an
   invite by email — this is a missing feature, not a config gap.
4. **No developer webhook has ever been delivered to a real external
   endpoint.** Blocks offering the Public API's webhook feature to real
   developers until §6's external test is run.
5. **No mobile build has ever been produced.** Blocks any mobile app
   store submission or real-device testing until a real Flutter
   toolchain runs a build — this cannot be verified further in this
   sandbox.
6. **OAuth token revocation on disconnect is not implemented** (unchanged
   from Phase 18.10, not addressed this phase — out of Phase 18.1's
   scope). Disconnecting an integration clears local state but never
   calls the provider's real revoke endpoint. Not a launch blocker for a
   first release, but a real gap a security-conscious user could notice;
   should be fixed before or shortly after launch.

Every other item in this report — token encryption, credential leakage,
CSRF, reverse-proxy/session behavior, data retention, admin panel
security, and the full regression suite — is **implemented and tested in
this environment** and does not block launch on its own merits. The six
items above are the honest, complete list of what still needs a real
external system or a real build tool this sandbox has never had access
to, before Autopilon should be trusted with real users and real
credentials.
