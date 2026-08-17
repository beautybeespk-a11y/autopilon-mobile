# Phase 18.10 — OAuth, Billing, Admin, Privacy Production Review

A code-review pass over OAuth flows, Stripe webhook handling, admin panel
access controls, and account/org/API-key deletion cascades — real bugs
fixed and verified, the rest documented per Phase 18's own instructions
("fix real bugs found, document the rest").

## OAuth flows (Gmail, Google Calendar/Drive/Docs/Sheets, Meta Ads)

Shopify/WooCommerce/WordPress don't use OAuth — they're manual-token/
application-password integrations per their own `.env.example` comments,
so they're out of scope for an "OAuth flow" review by definition.

### FIXED: OAuth CSRF `state` used a non-cryptographic RNG

`routes/gmailAuth.js`, `routes/metaAuth.js`, and `routes/googleServiceAuth.js`
all generated their OAuth `state` parameter (the CSRF protection for the
redirect flow — state is stored in the session at `/connect` and compared
on `/callback`) with `middleware.js`'s `cryptoRandom()`, which is
`Date.now().toString(36) + Math.random().toString(36)` — not a CSPRNG.
Every other genuinely security-sensitive token already generated in this
codebase (API keys, webhook signing secrets, file-share tokens — see
`orchestrator/apiKeyService.js`, `developerWebhookService.js`,
`fileShare.js`) already correctly uses `crypto.randomBytes`; OAuth state
was the one inconsistent case.

**Fix**: added `secureRandomToken()` to `middleware.js` (`crypto.
randomBytes(32).toString("hex")`) and switched all three OAuth routers to
use it for `state` generation. `cryptoRandom()` itself is unchanged and
still used everywhere it always was (non-security-sensitive ids) — this
was a narrow, targeted fix, not a rewrite of the id-generation scheme.

**Verified**: syntax-checked; the state comparison logic itself
(`state !== req.session.xOAuthState`, then `delete` it — single-use) was
already correct and unchanged; full regression suite (76/76) re-run clean.

### DOCUMENTED, NOT FIXED: OAuth access/refresh tokens stored in plaintext

`integrations/manager.js`'s `saveConnection()`/`saveOrgConnection()` write
`accessToken`/`refreshToken` directly into the `integrations` table with
no encryption. This codebase already has the exact mechanism this needs —
`orchestrator/secretsCrypto.js`'s `encryptSecret()`/`decryptSecret()`,
already used for BYOK provider keys and developer webhook signing secrets
— but it was never applied here.

**Why not fixed in this pass**: unlike the `state`-generation fix (3 call
sites, one line each, fully testable without real credentials), this token
is *read* directly (not through one central getter) in at least 12
call sites across `gmail/api.js`, `google/tokenHelper.js`, `woocommerce/
index.js`, `shopify/index.js`, `wordpress/index.js`,
`whatsapp/services/ownerLookup.js`, `routes/woocommerceAuth.js`,
`routes/shopifyAuth.js`, `routes/orgIntegrations.js`, `routes/wordpressAuth.js`,
`routes/whatsappWebhook.js`, plus `integrations/manager.js`'s own
`connectionHealth()`/`requireValidToken()`. Retrofitting encryption means
every one of those reads needs a `decryptSecret()` call, and — critically
— **there are no real OAuth credentials available in this sandboxed
environment to test against** (no live Google/Meta account to actually
exchange a code, store a real token, and confirm every read path still
decrypts and uses it correctly). Given Phase 18's explicit rule against
claiming untested changes work, and the real risk of a missed call site
silently breaking every connected integration, this is left as a clearly
documented, well-scoped finding for a follow-up pass that CAN be tested
against real credentials — not fixed blind.

**Recommended fix shape** (for that follow-up): encrypt in `saveConnection`/
`saveOrgConnection` before the `UPDATE`/`INSERT`; add a single `getAccessToken(conn)`
helper in `integrations/manager.js` that decrypts, and route every one of
the 12 read sites through it instead of reading `.accessToken` directly.

### DOCUMENTED, NOT FIXED: disconnecting an integration doesn't revoke the token at the provider

`disconnectIntegration()`/`disconnectOrgConnection()` only clear the local
DB columns (`accessToken = NULL`, etc.) — they never call Google's
`https://oauth2.googleapis.com/revoke` or Meta's equivalent revocation
endpoint. The token itself remains valid at the provider after a user
"disconnects" in the app; if it had ever leaked, disconnecting in-app
would not invalidate it.

**Why not fixed in this pass**: implementing this is straightforward
(a single POST call, well-documented, no new dependency), but it cannot be
verified without a real Google/Meta account and a real connected token —
there is nothing to call it against in this sandbox. Documented here
rather than shipped untested.

### VERIFIED CORRECT, no changes needed
- State validated on callback (`state !== session-stored value` → redirect
  with an error, `state` deleted after use — single-use, can't be replayed).
- Redirect URIs are derived from `GOOGLE_REDIRECT_URI`/`META_REDIRECT_URI`
  env vars, never hardcoded or accepted from the request.
- Token refresh (`refreshAccessToken()` in `integrations/google/oauth.js`,
  and Gmail's own `gmail/api.js`) correctly checks expiry before reuse and
  re-persists the refreshed token.
- OAuth tokens are never returned to the frontend in any API response
  (confirmed via the existing Phase 16 security regression suite's "API
  key exposure" checks, which cover the same class of leak for BYOK keys —
  a manual grep of every `res.json()` in the integrations routes confirms
  none include `accessToken`/`refreshToken`).

## Billing / Stripe webhook handling

**VERIFIED CORRECT, no changes needed.** `routes/stripeWebhook.js` +
`orchestrator/stripeService.js`:
- Signature verification uses Stripe's own SDK (`stripe.webhooks.
  constructEvent`), not a homegrown HMAC check — correct, timing-safe,
  handles timestamp tolerance internally.
- Idempotency: every event is checked against `webhook_dedup` (shared with
  WhatsApp's dedup, namespaced `stripe:<event.id>`) before processing —
  Stripe's documented at-least-once delivery is handled correctly.
- Retry semantics: a processing failure returns 500 (Stripe retries); a
  bad signature returns 400 (Stripe does not retry a signature failure,
  correctly — retrying wouldn't fix a bad signature).
- Handled event types (`checkout.session.completed`, `customer.
  subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed`) match exactly what `.env.example` documents
  configuring at Stripe's dashboard; unhandled types are ignored, not
  errored, which is correct (Stripe sends many event types this app
  doesn't act on).

## Admin panel session/auth controls

**VERIFIED CORRECT, no changes needed.** `routes/platformAdmin.js`'s
blanket `router.use(requireAuth, requirePlatformAdmin)` gates every route
in the file. `requirePlatformAdmin` (`middleware.js`) queries the
`isPlatformAdmin` flag fresh from the DB on every single request — no
caching in the session, so demoting an admin takes effect on their very
next request, not after their session expires. Already covered by the
Phase 16 regression suite's "privilege escalation" checks (a regular user
cannot list orgs / flip maintenance mode / manage feature flags / etc.) —
all still passing.

## Account / org / API-key deletion cascades and data retention

### FIXED: deleting an organization orphaned data in 17 tables, including real files on disk

`orchestrator/organizationManager.js`'s `deleteOrganization()` was a
single `DELETE FROM organizations WHERE id = ?`, with a comment claiming
"cascades to members/workspaces/roles." That's true for the 13 tables that
declare a real `FOREIGN KEY ... ON DELETE CASCADE` in `db.js` (subscriptions,
usage_records, organization_members, workspaces, custom_roles, api_keys,
developer_api_keys, developer_webhooks, api_agent_runs, organization_credits,
organization_spend_limits, coupon_redemptions, invoices). It was **not**
true for 17 more tables that also carry an `orgId` column: `agents`,
`automations`, `integrations`, `tasks`, `knowledge_items`,
`organization_usage`, `quota_warnings_sent`, `voice_usage`, `folders`,
`files`, `content_brands`, `content_templates`, `content_assets`, `jobs`,
`api_request_logs`, `api_idempotency_keys`, `activity_logs`. Every one of
these got its `orgId` column added later via `ALTER TABLE ADD COLUMN`
(confirmed by grep against `db.js`), and **SQLite's `ALTER TABLE` cannot
add a foreign key constraint to an existing table** — so these columns
were always unenforced. Deleting an org left every row in these tables
behind, orphaned, still holding real data: uploaded files (with their
actual bytes still sitting in storage, S3 or local disk — a genuine
storage leak, not just a DB row), generated content, task/knowledge
content, agent configurations.

**Fix**: `deleteOrganization()` now runs the real, explicit cleanup —
deleting each org-owned file's storage bytes first (same per-version
`storageProvider.delete({ key })` call `fileService.js`'s own
`permanentlyDeleteFile()` makes, done directly here since this needs to
delete every member's files regardless of who uploaded them, not just one
user's own), then a transaction that clears `files` (its own FK cascade
handles `file_versions`/`file_permissions`/`file_tags`/`file_shares`/
`file_activity`/`file_links`) and the other 15 metadata-only tables, and
finally deletes the `organizations` row itself (which still triggers the
13 real FK cascades).

`activity_logs` is deliberately **excluded** from the cleanup — it's the
audit trail, and an audit record of "this org was deleted, by whom, when"
needs to survive the deletion it's recording. `routes/organizations.js`'s
delete route now logs the `organization_deleted` activity entry **before**
calling `deleteOrganization()`, for the same reason (logging after would
have the org's own history already need to reference a gone org id, and —
before this fix's own transaction — the deletion order made this a race).

**Tested for real**: wrote a direct test that inserts a real row into
every one of the 17 affected tables (plus a real `file_versions` row and
real bytes written to local disk storage) for a real organization, then
calls `deleteOrganization()` and asserts each table is empty (0 rows) for
that org afterward, that `activity_logs` still has the pre-existing entry
(retained), that the org row itself is gone, and — critically — that the
uploaded file's actual bytes are gone from disk (`storageProvider.exists()`
false), not just its DB row. All 16 assertions passed. Also drove the real
`DELETE /api/organizations/:id` HTTP route end-to-end (signup, create org,
delete via curl) and confirmed `{"deleted":true}`. Full regression suite
(76/76) re-run clean afterward.

### DOCUMENTED, NOT IMPLEMENTED: no user-initiated account (self) deletion

There is no `DELETE /api/auth/me` or equivalent — a user can delete an
*organization* they own, but there is no way for a user to delete their
own *account* (the `users` row itself, and everything scoped to `userId`
rather than `orgId` — personal agents, personal files, personal API keys
if any exist outside an org, etc.). This is a genuine gap against the
original Phase 18 spec's "Account Deletion" section (§38), which expects
user-deletes-account as one of the flows to verify. Building this is a new
user-facing feature (a full "delete my account" flow: confirmation,
cascading every `userId`-scoped table the same way this fix just did for
`orgId`-scoped ones, handling the case where the user is the sole owner of
an organization, etc.) — meaningfully larger than a bug fix, and explicitly
the kind of net-new feature work Phase 18's rules say not to add
unprompted. Documented here as a real, current gap for a future phase.

## Real OAuth staging setup (Phase 18 §11 — no live credentials available here)

Exact steps to actually test the Gmail/Google-service/Meta OAuth flows in
a real staging environment (none of this was performed here — no real
Google/Meta developer account credentials exist in this sandbox):

1. **Google** (Gmail + Calendar/Drive/Docs/Sheets — one shared OAuth client):
   - Create a project at console.cloud.google.com, enable the Gmail,
     Calendar, Drive, Docs, and Sheets APIs for it.
   - Create an OAuth 2.0 Client ID (Web application type).
   - Add **every** service's real staging callback URL to "Authorized
     redirect URIs": `https://<staging-domain>/api/integrations/gmail/callback`,
     `.../google_calendar/callback`, `.../google_drive/callback`,
     `.../google_docs/callback`, `.../google_sheets/callback` (the shared
     origin is derived from `GOOGLE_REDIRECT_URI` — see `integrations/
     google/oauth.js`'s `baseOrigin()` — so only the Gmail one needs to be
     set as the env var; the others are derived automatically, but Google
     still needs each one explicitly registered as authorized).
   - Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
     in the staging environment's secret manager.
   - Test: log in to the staging app, go to Integrations, click Connect on
     Gmail, complete Google's consent screen, confirm redirect back with
     `?gmail_connected=1` and a real `connectionHealth()` showing connected.
     Repeat for each Google service. Test disconnect + reconnect. Test
     letting a token expire (or manually clearing `tokenExpiresAt` in the
     DB) and confirm `requireValidToken()` triggers a real refresh.
2. **Meta** (Ads + WhatsApp):
   - Create an app at developers.facebook.com, add the Marketing API and
     WhatsApp Business products.
   - Set the OAuth redirect URI to `https://<staging-domain>/api/integrations/meta/callback`.
   - Set `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` in staging.
   - Test the same connect/disconnect/reconnect/expiry flow as Google above.
3. For both: verify cross-org isolation for real — connect the same
   provider from two different staging test organizations, confirm each
   org's connection is independent (already covered by the app's org-scoped
   `saveOrgConnection`/`getOrgConnection` design, but worth a real
   end-to-end confirmation once real credentials exist).
