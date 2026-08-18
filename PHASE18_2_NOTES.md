# Phase 18.2 — Integration Credential Lifecycle & Disconnect Hardening

Completion report for the focused pass that closed the one
application-level gap Phase 18.1's own report identified: **OAuth
revocation on disconnect was not implemented.** This phase touched no
product features and made no unrelated refactors — every change below is
a security/correctness fix to the existing credential lifecycle
(connect → authorize → store → use → refresh → revoke/disconnect →
delete → reconnect), made with the smallest safe diff and verified with a
real regression test before being committed. No existing architecture
(Universal Integration SDK, credential encryption, permissions, tenant
isolation, audit logging, Tool Registry) was redesigned or bypassed.

**Classifications used, exactly as specified for this phase:**
- **IMPLEMENTED + TESTED** — real code, real test, actually passing in
  this environment.
- **IMPLEMENTED + EXTERNAL TEST REQUIRED** — the code is real and
  reviewed/tested as far as this sandbox can reach, but a final check
  needs a real external credential or service this sandbox has never had.
- **CONFIGURATION READY** — nothing left to build; only real
  credentials/infrastructure stand between this and a working staging
  test.
- **NOT IMPLEMENTED** — doesn't exist yet; explicitly out of scope for
  this phase (a feature, not a fix), or inapplicable to a given provider.
- **PRODUCTION BLOCKER** — must be resolved before real users/real
  credentials touch this system.

---

## 1. Credential Flow Audit — IMPLEMENTED + TESTED

Every integration was traced end to end: how a connection is created
(`saveConnection`/`saveOrgConnection` in `integrations/manager.js`), how
it's stored (AES-256-GCM at rest, Phase 18.1), how it's read/decrypted
(`getConnection`/`getOrgConnection`/`listOrgConnections`, decrypt
centralized in those three functions), how it's refreshed
(`gmail/api.js`'s and `google/tokenHelper.js`'s `getValidAccessToken()`),
how it's revoked/disconnected (`disconnectIntegration`/
`disconnectOrgConnection`, plus this phase's new provider revoke calls),
and what happens on reconnect (a fresh `saveConnection`/
`saveOrgConnection` call, same upsert path as first connect — no
separate "reconnect" code path to drift out of sync). No credential
values are reproduced anywhere in this report, consistent with the
phase's own instruction.

**Confirmed by audit, not assumption**: there is no credential caching
layer anywhere in the integrations code (`grep -rn "cached(\|
cacheProvider\|CACHE_PROVIDER" integrations/` returns nothing not related
to unrelated Maps like the SDK's tool registry or rate-limiter buckets)
— every credential read is a fresh, synchronous, decrypted DB read. This
means §6 (cache invalidation) is satisfied by construction, not by adding
new invalidation logic to a cache that doesn't exist.

---

## 2 & 3. OAuth Disconnect Revocation + Provider Classification — IMPLEMENTED + TESTED (Google, Meta) / NOT IMPLEMENTED (inapplicable — 4 providers)

| Provider | Credential type | Revocation classification | Detail |
|---|---|---|---|
| Gmail | OAuth 2.0 (Google) | **SUPPORTED** | `POST https://oauth2.googleapis.com/revoke`, form-encoded `token=<refresh_or_access_token>`. Revoking the refresh token invalidates the whole grant, including any derived access tokens. |
| Google services (Calendar + 3 others, via the shared `createGoogleServiceRouter` factory) | OAuth 2.0 (Google) | **SUPPORTED** | Same endpoint/mechanism as Gmail — one implementation in `integrations/google/oauth.js`, used by all 4 services through the shared router. |
| Meta Ads | OAuth 2.0 (Meta) | **SUPPORTED** | `DELETE https://graph.facebook.com/{API_VERSION}/me/permissions`, authenticated via an `Authorization: Bearer <token>` header (not the `?access_token=` query param the rest of the app's Meta client uses, deliberately — keeps the token out of access logs, mirroring the Phase 18.1 WooCommerce fix). De-authorizes the whole app grant. |
| Shopify | Manual access token (merchant-issued, not an OAuth grant this app manages) | **NOT SUPPORTED BY PROVIDER** (via this app) | No revoke call exists for this credential shape; the merchant must revoke it from their own Shopify admin. Documented in the disconnect response (`revoked: null`) and in `EXTERNAL_INFRASTRUCTURE.md`. |
| WooCommerce | REST API consumer key/secret | **NOT SUPPORTED BY PROVIDER** (via this app) | Same reasoning — a WooCommerce REST API key is revoked from the store's own WooCommerce settings, not through any endpoint this app can call. |
| WordPress | Application password | **NOT SUPPORTED BY PROVIDER** (via this app) | Application passwords are revoked from the WordPress user's own profile page; there is no programmatic revoke API. |
| WhatsApp | Business API token (manually provided) | **NOT SUPPORTED BY PROVIDER** (via this app) | Same reasoning as the above three — a manually-issued token, not a grant this app negotiated and can therefore ask the provider to revoke. |

No fake or invented revocation endpoint was added for the four
NOT-SUPPORTED providers — their disconnect routes now explicitly return
`revoked: null, revocationError: null` with a code comment explaining
why, rather than silently omitting the field (which would look
indistinguishable from "revocation wasn't attempted" vs. "revocation
isn't possible").

**The 10-step disconnect flow required by §2** is implemented exactly as
specified in `routes/gmailAuth.js`, `routes/googleServiceAuth.js`, and
`routes/metaAuth.js`: authenticate (existing `requireAuth`) → verify
ownership (`getConnection(req.session.userId, provider)`, scoped to the
authenticated user/org) → retrieve the encrypted credential via the
existing manager functions (decryption happens only inside
`integrations/manager.js`, never in a route handler) → call the
provider's real revoke endpoint → treat a `400 invalid_token` response
from Google (or an already-revoked grant from Meta) as revocation having
already succeeded, not a failure → on any other provider error, record
`integration_revocation_failed` in the audit log with the error message
only (never a token value) → **always** call `disconnectIntegration` /
`disconnectOrgConnection` regardless of whether the provider call
succeeded → record `integration_disconnected` → respond
`{ ok: true, revoked, revocationError }`, never a token. A failed
provider-side revocation is never treated as permission to leave local
credentials usable — the local clear happens unconditionally, verified
directly by test.

**Testing**: new suite `test/oauthRevocationRegression.js`, **11/11
checks** — revoke-endpoint construction for Google and Meta, the
`invalid_token`-as-success path, provider-failure error messages
confirmed to never contain a token substring, full disconnect success/
failure/no-token-to-revoke paths, Google-Calendar disconnect parity with
Gmail (proving the shared-router factory carries the fix to all 4 Google
services), and idempotent double-disconnect.

---

## 4, 5, 6. Safe Disconnect + Queued Job Safety + Cache Invalidation — IMPLEMENTED + TESTED

Access/refresh tokens are unusable immediately after disconnect (the row
is cleared, not just marked); there is no separate "cache" of the
credential anywhere to also clear (§1's audit finding). A job enqueued
before a disconnect but processed after it now fails safely and
immediately rather than being retried pointlessly — this required a real
fix, described in the bugs-found section below.

**Testing**: new suite `test/queuedJobCredentialSafetyRegression.js`,
**4/4 checks** — a real Job Manager job (registered exactly the way every
production job handler in `jobs/handlers.js` is structured) that calls
the real `requireValidToken()`; confirms a job queued before disconnect
and processed after it fails immediately (not retried), the connection is
left in a clean fully-disconnected state, and there is no stale read even
on a rapid back-to-back query.

---

## 7. Token Refresh Safety — IMPLEMENTED + TESTED (found and fixed a real race condition)

Valid-token, expired-token, refresh-token-present, refresh-failure,
revoked-refresh-token, and concurrent-refresh scenarios were all tested
against real production code (`gmail/api.js`'s `checkConnection() →
getValidAccessToken()`), mocking only Google's own token/profile
endpoints at the fetch boundary.

**Found and fixed a real security-relevant race**: `getValidAccessToken()`
does `await refreshAccessToken(...)` — a real network round-trip that
yields control in Node's event loop — then unconditionally persisted the
refreshed token. A disconnect completing during that await window had its
credential-clearing silently undone the moment the refresh resolved and
wrote the (now-stale) refreshed token back. This has existed since Phase
18.1's encryption work; nothing before this phase's explicit "test
disconnect during/around refresh" requirement (§7) exercised it. Fixed in
both `integrations/gmail/api.js` and `integrations/google/tokenHelper.js`:
after a refresh resolves, the connection's live status is re-checked
before persisting; if it's no longer `connected`, the refreshed token is
discarded and `INTEGRATION_NOT_CONNECTED` is thrown instead of
resurrecting the row.

**Testing**: new suite `test/tokenRefreshSafetyRegression.js`, **7/7
checks**, including a deterministic race simulation (the mocked token
endpoint's own response handler calls `disconnectIntegration()`
synchronously, reproducing the exact race window) that fails against the
pre-fix code and passes against the fix. Refresh tokens are never
returned in any response; refreshed tokens are encrypted before
persistence (same `saveConnection` path as first connect); a failed
refresh never overwrites a previously-valid credential with garbage.

---

## 8 & 9. Reconnect Behavior + Cross-User/Cross-Org Security — IMPLEMENTED + TESTED

Full CONNECT → USE → DISCONNECT → RECONNECT → USE cycles were exercised
for real, including the specific three-way scenario the spec called out
by name: a personal connection and two different organizations'
connections for the **same provider**, coexisting and independently
readable/disconnectable/reconnectable — the exact case the Phase 18.1
schema fix (splitting one unique index into two partial indexes) made
possible. A third, unrelated organization was included specifically to
confirm disconnecting one org's connection never touches another's.

**Testing**: new suite `test/reconnectAndIsolationRegression.js`,
**15/15 checks**, clean pass on first write — no bugs found here. Old
credentials are confirmed unreusable after reconnect; new credentials
replace them cleanly with correct encryption; org/user ownership
(`connectedByUserId`) stays correct through the cycle; no duplicate or
half-broken rows are left behind; permission and audit history remain
correct across the cycle.

---

## 10. Credential Deletion — IMPLEMENTED + TESTED

Verified at disconnect (both personal and org-level), at org deletion
(Phase 18.1's existing cascade, re-confirmed unchanged this phase), and
through the reconnect cycle (old ciphertext is genuinely replaced, not
left alongside the new value). Failed/cancelled OAuth flows never reach
`saveConnection` at all (the connect route only calls it after a
successful token exchange), so there is no partial-credential row to
clean up in that case by construction. Audit records for every
connection-lifecycle event store only safe metadata (provider, status,
user/org id, timestamp, and — for failures — the error message); no
audit row anywhere contains a token, key, or secret value, confirmed by
the credential-leakage regression suite (§14 below).

---

## 11. Audit Logging — IMPLEMENTED + TESTED

Completed the event taxonomy the spec requires. Pre-existing:
`integration_connected`, `integration_disconnected`. Added this phase:
`integration_connection_failed` (and its org-level counterpart
`org_integration_connection_failed`), `integration_refreshed`,
`integration_revocation_failed`. All new events reuse the existing
`logActivity()` helper and the existing `activity_logs` table — no new
audit architecture was built. Every one of these events records
provider/status/error-message metadata only, never a token or secret
value.

**Verified, not assumed, that the existing Admin Panel/API surfaces
these with no code changes needed**: `GET /api/activity` (a user's own
events) and `GET /api/organizations/:orgId/audit-logs` (owner/admin,
free-form `?action=` filtering) both already have no allow-list of
recognized action strings, so the new event types are queryable and
displayable immediately.

**Testing**: new suite `test/auditLoggingAndApiResponseRegression.js`,
part of its **5/5 checks** — a real in-process Express harness mounting
the actual production route files (not a separately-booted server),
confirming `GET /api/activity` surfaces `integration_connection_failed`
for the affected user with no credential value present, and that
`GET /api/organizations/:orgId/audit-logs` correctly filters to a
specific integration event by action name.

---

## 12. API Response Security — IMPLEMENTED + TESTED

Every disconnect/connect/status response was reviewed and tested to
confirm it returns only safe metadata (provider, status, account
identifier where applicable, connected date, `revoked`/`revocationError`)
and never an access token, refresh token, client/consumer secret, or
password — including the new `revoked`/`revocationError` fields
introduced this phase, which by construction can only ever contain a
boolean/error-message, never the credential itself (verified directly:
the disconnect route never has the raw token in scope by the time it
builds the response).

**Testing**: covered by `test/auditLoggingAndApiResponseRegression.js`
(disconnect response body checked for the literal token substring) and
by the pre-existing `test/credentialLeakageRegression.js`, both passing.

---

## 13. SDK Security — IMPLEMENTED + TESTED (no change required)

Reviewed `integrations/sdk/index.js`. Credential resolution stays fully
server-side; SDK consumers never receive a raw credential. Two exports —
`describeIntegration()` and `listSdkIntegrations()` — have zero callers
anywhere else in the application (confirmed by grep for every plausible
call-site name), meaning they are inert, not a currently-exploitable leak
surface. Not removed this phase — deleting unused exports is unrelated
cleanup outside this phase's scope — but flagged here for a future
pass. The least-privilege model (Tool Registry gating what an agent may
call) was not touched.

---

## 14. WooCommerce Credential Review — IMPLEMENTED + TESTED

Full fresh regression search confirmed the Phase 18.1 fix
(`wcFetch()` in `integrations/woocommerce/api.js`, sending credentials
via an `Authorization: Basic` header over HTTPS) is the **sole** choke
point for all WooCommerce credential usage in the codebase — no second
code path constructs a WooCommerce request with credentials in the URL,
logs them, returns them, or stores them unencrypted.

**Testing**: `test/credentialLeakageRegression.js` (pre-existing, 8/8
passing, unchanged) includes the dedicated regression check added in
Phase 18.1 that specifically asserts the captured outbound request never
carries the consumer key/secret as a URL query parameter.

---

## 15. Integration Action Security — IMPLEMENTED + TESTED (found and fixed a stale test-fixture bug)

Re-ran the Phase 17.1 Integration Action API suite and extended it with
3 new checks: a disconnected integration's action is rejected as not
found (not silently executed), the public action list correctly reflects
that unavailability rather than showing stale data, and reconnecting
restores the ability to execute — proving disconnect is not permanent
damage to an otherwise-healthy integration/agent/API-key configuration.
Credential resolution continues to use the correct org/user scope; the
existing Tool Registry and permission system were not bypassed or
duplicated.

**Found and fixed a real test-integrity bug while extending this
suite**: the suite's `connectGmail()` test fixture inserted a raw,
unencrypted fake token directly into the `integrations` table, bypassing
`saveConnection()`'s AES-256-GCM encryption entirely. Since Phase 18.1's
encryption rollout, that plaintext value silently fails
`decryptToken()`'s parse and returns `null` — meaning the fixture's
connection looked `connected` in the raw DB row but `connectionHealth()`
actually reported it as disconnected. A test whose own comment claimed
to "reach the actual underlying integration" had, since Phase 18.1, been
silently stopping at the not-connected gate instead — passing for the
wrong reason. Fixed by routing the fixture through the real
`saveOrgConnection()`; confirmed via a standalone verification script
that the old fixture value genuinely failed to decrypt, and that after
the fix the test now reaches a real outbound Gmail call (which correctly
fails with a real, expected 401 against a fake token — the test asserts
that failure, not a successful mocked call).

**Testing**: `test/integrationActionRegression.js`, **15/15 checks**
(12 pre-existing + 3 new this phase).

---

## 16, 17, 18. Failure Handling + Idempotent Disconnect + Concurrency — IMPLEMENTED + TESTED

Provider 401/403 responses, a network-level fetch rejection, and a
request that times out (verified via a real `AbortController` wired
through the 3 new `revokeToken()` functions with a 10-second bound,
injected with `DOMException("...", "AbortError")` to deterministically
trigger the timeout path) were all tested. None of these expose a
credential, crash the process, leave a stale credential silently usable,
or report a revocation as successful when it wasn't. Disconnect is
idempotent — safe to call twice sequentially or simultaneously from two
concurrent requests, with no credential resurrection, no duplicate
destructive errors, and no leaked secret in either response. Concrete
races were exercised: refresh-vs-disconnect (§7's fix), connect-vs-
disconnect (last writer wins cleanly, never a half-corrupted state), and
reconnect-vs-old-worker (a job queued before a reconnect resolves the
*current* credential when it actually runs, never a captured stale one).
No new distributed-locking system was introduced — the existing
DB-transaction/upsert semantics in `integrations/manager.js` were
sufficient for every race tested.

**Note on scope**: the whole pre-existing integrations layer has never
had fetch timeouts anywhere (`grep -rln "AbortController\|signal:"
integrations/` returned nothing before this phase). This phase added a
bounded timeout only to the 3 new `revokeToken()` calls it introduced —
a scoped fix, not a retrofit of timeout handling across the entire
integrations layer, which remains a known, pre-existing characteristic
out of this phase's scope.

**Testing**: new suite `test/failureHandlingAndConcurrencyRegression.js`,
**9/9 checks**.

---

## 19 & 22. Security Regression + Final Test Matrix — IMPLEMENTED + TESTED

All suites — the 10 pre-existing files from Phases 16/17/17.1/18/18.1
plus the 6 new ones written this phase — were re-run to completion
against freshly booted servers (fresh `DB_PATH` each time, no state
carried over) as the very last step of this phase.

| Suite | Result |
|---|---|
| Core security regression (`test:security`) | 24/24 |
| Public API security (`test:security:public-api`) | 30/30 |
| Idempotency-Key (`test:idempotency`) | 10/10 |
| Integration Action API (`test:integration-actions`) | 15/15 (12 baseline + 3 new) |
| Credential leakage (`test:credential-leakage`) | 8/8 |
| CSRF (`test:csrf`) | 7/7 |
| Production logging (`test:production-logging`) | 3/3 |
| Data retention (`test:data-retention`) | 10/10 |
| Admin panel security (`test:admin-panel`) | 9/9 |
| Reverse proxy — direct mode | 2/2 |
| Reverse proxy — production/proxy mode | 5/5 |
| OAuth revocation (`test:oauth-revocation`) — **new** | 11/11 |
| Queued job credential safety (`test:queued-job-credential-safety`) — **new** | 4/4 |
| Token refresh safety (`test:token-refresh-safety`) — **new** | 7/7 |
| Reconnect + isolation (`test:reconnect-isolation`) — **new** | 15/15 |
| Audit logging + API response (`test:audit-api-response`) — **new** | 5/5 |
| Failure handling + concurrency (`test:failure-concurrency`) — **new** | 9/9 |
| **Total** | **174/174 across 16 suite files** |

No existing check was weakened, skipped, or had its assertion loosened to
make it pass. The 3 real bugs found during this phase (retry-forever gap
on a permanently-unfixable disconnect error, the disconnect-during-refresh
resurrection race, and the stale unencrypted test fixture) were all fixed
at the source, and the tests that found them were kept as permanent
regression coverage, not deleted or watered down afterward.

A full TEST/RESULT/ENVIRONMENT/NOTES matrix (covering every area listed
in the phase spec plus the external-test-required items) is in
`PRODUCTION_READINESS.md` under "Phase 18.2 Final Test Matrix."

---

## 20. External Test Boundary — Honestly Documented

The following were **not** tested against real infrastructure in this
sandbox, and no claim is made otherwise:

- **A real Google or Meta OAuth account.** Revocation is implemented
  against the correct real endpoints (§3), and every code path around it
  is tested against a mocked provider boundary — but no live account in
  this sandbox has ever actually accepted a real `/revoke` call or a real
  `/me/permissions` DELETE. **IMPLEMENTED + EXTERNAL TEST REQUIRED.**
- **Real external webhook delivery, transactional email, and Flutter
  mobile compilation** — unchanged from Phase 18.1's own external-test
  boundary; not touched or claimed to be resolved by this phase.
- **Real Stripe account/billing flows** — unchanged from Phase 18.1;
  out of this phase's scope entirely (billing was not part of the
  credential-lifecycle work).

---

## 21. Documentation — IMPLEMENTED + TESTED (as documentation)

Updated with real, verified content from this phase's actual findings:

- **`STAGING_CHECKLIST.md`** — OAuth-tokens-encrypted-at-rest flipped
  FAIL → PASS (was already fixed in Phase 18.1, checklist just hadn't
  caught up); added rows for per-provider revocation status, local-clear-
  regardless-of-revocation-outcome, cross-org isolation, the disconnect-
  during-refresh fix, queued-job safety, and cache invalidation.
- **`EXTERNAL_INFRASTRUCTURE.md`** — added a note on confirming
  provider-side revocation during staging (checking Google's/Meta's own
  "apps with access" pages) plus manual-revocation instructions for the
  4 non-OAuth providers.
- **`DEPLOYMENT_RUNBOOK.md`** — §12's OAuth staging-test step now
  references `npm run test:oauth-revocation` and the provider-account-
  settings check; all 6 new Phase 18.2 test scripts added to the
  "also worth running" list.
- **`PRODUCTION_READINESS.md`** — the "OAuth token revocation on
  disconnect" row flipped from NOT READY to READY (implemented) /
  EXTERNAL TEST REQUIRED (live-provider round trip); added rows for
  non-OAuth revocation status, the disconnect-during-refresh fix, queued-
  job safety, and cache invalidation; added the full final test matrix
  (§19/§22 above).

---

## Bugs Found and Fixed This Phase

1. **Retry-forever gap on a permanently-unfixable error**
   (`integrations/manager.js`'s `requireValidToken()`): a queued job that
   hit a disconnected integration was being retried by the Job Manager
   instead of failing immediately, because the thrown
   `INTEGRATION_NOT_CONNECTED` error didn't set `err.retryable = false`
   (the flag `jobs/jobManager.js` checks, following the existing
   precedent in `jobs/handlers.js`'s webhook-delivery handler). Fixed at
   the source.
2. **Disconnect-during-refresh credential resurrection race**
   (`integrations/gmail/api.js`, `integrations/google/tokenHelper.js`) —
   see §7 above. The most significant finding of this phase: a real,
   if narrow-window, security-relevant bug that existed since Phase
   18.1 and had never been exercised by a test until this phase's
   explicit requirement to test disconnect during/around refresh.
3. **Stale, silently-broken test fixture**
   (`test/integrationActionRegression.js`'s `connectGmail()`) — see §15
   above. Not a production bug, but a real gap in test integrity: one of
   the suite's own assertions had been passing for the wrong reason since
   Phase 18.1.

No other application-level defect was found. No working security control
was weakened anywhere in this phase.

---

## Final Summary

**PHASE 18.2 STATUS: COMPLETE.** Every application-level task in the
phase specification is implemented and tested in this environment: OAuth
disconnect revocation for Google and Meta (the only two providers that
support it), honest provider classification for all 7 integrations, safe
disconnect/queued-job/cache behavior, token refresh safety (including a
real race condition found and fixed), full reconnect and cross-user/
cross-org isolation, complete credential deletion, a completed audit
event taxonomy, verified API response security, SDK security review,
WooCommerce regression, Integration Action API re-verification (with a
real test-integrity bug found and fixed), failure-mode handling,
idempotent disconnect, and concurrency safety. 174/174 checks passing
across 16 regression suite files, run fresh as the final step of this
phase.

**APPLICATION-LEVEL BLOCKERS:** None. The one item Phase 18.1 identified
as an application-level gap (OAuth revocation on disconnect) is now
implemented and tested for the two providers that support it; the other
four providers' inability to support remote revocation is inherent to
their credential type (manual tokens/keys/passwords), not a code gap.

**EXTERNAL-INFRASTRUCTURE BLOCKERS (unchanged in substance from Phase
18.1, carried forward, not re-solved by this phase):**
1. No real Google or Meta OAuth account has ever accepted a real
   connect/revoke round trip in this sandbox.
2. No real Stripe event has ever been received (out of this phase's
   scope).
3. Transactional email does not exist (missing feature, not a gap this
   phase addresses).
4. No developer webhook has ever been delivered to a real external
   endpoint (out of this phase's scope).
5. No mobile build has ever been produced (out of this phase's scope).

**TEST RESULTS:** 174/174 across 16 suite files (123 from the 10
pre-existing suites, including 3 new checks added to the Integration
Action API suite; 51 from the 6 new suites written this phase). Zero
failures, zero skipped assertions, zero weakened checks.

**READY FOR PHASE 19: YES**, on the application level — every item this
phase's specification required has been implemented and tested. The
external-infrastructure blockers listed above are unchanged from Phase
18.1 and require real credentials/services this sandbox cannot provide;
they should be resolved during an actual staging deployment, not by
further code work in this sandbox. Phase 19 is not started here, per this
phase's explicit instruction.
