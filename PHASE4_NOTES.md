# Phase 4 — Integrations Framework + Meta Ads

## Read this before testing — the setup burden is real
Unlike Phases 1-3, this phase can't be made to work just by adding an API
key in `.env`. Meta requires **you personally** to create a Meta Developer
App and register exact OAuth details before any of this code can connect to
anything. This isn't a shortcut I skipped — it's a real step Meta requires
of every developer, with no way around it. Steps:

1. Go to developers.facebook.com → **My Apps** → **Create App** → choose
   type "Business".
2. Add the **Marketing API** product to the app.
3. Under **Settings → Basic**, copy the **App ID** and **App Secret**.
4. Under **Marketing API → Settings** (or wherever your app version shows
   OAuth redirect config), add a **Valid OAuth Redirect URI** — it must be
   the *exact* URL this app will use, e.g.
   `https://<your-codespace-url>/api/integrations/meta/callback`.
5. Set the three env vars (`META_APP_ID`, `META_APP_SECRET`,
   `META_REDIRECT_URI`) to match.

**Known friction points, told straight:**
- Your Codespace's forwarded URL can change if the Codespace is recreated —
  if that happens, you'll need to update both the Meta App's redirect URI
  *and* `META_REDIRECT_URI` to match again. This is a real limitation of
  testing OAuth from a Codespace rather than a fixed domain.
- The `ads_management` scope this app requests is normally subject to
  **Meta App Review** for public/production use. However, while your app is
  in **Development Mode**, you (and anyone you add as an Admin/Developer/
  Tester on the app) can authorize it against your *own* ad account without
  review — which is exactly the case for testing this yourself. If you ever
  want other people to connect their own Meta accounts, App Review becomes
  mandatory.
- Meta does not issue a classic refresh token for user access tokens. This
  app exchanges the short-lived token for a long-lived one (~60 days) at
  connect time; when that expires, the fix is simply reconnecting via
  Integrations — there's no silent refresh, and that's normal Meta behavior,
  not a bug here.

## Architecture summary
`server/integrations/manager.js` is the reusable Integration Manager: a
registry of integration *definitions* (id, name, category, auth type,
supported tools, required scopes) plus connection *state* storage (tokens,
status, expiry) in the existing `integrations` table, extended with new
columns. Adding Gmail/Drive/WooCommerce/etc. later means: a new definition
file, an OAuth routes file, a tools file — the Orchestrator and Tool
Registry never change, exactly as required.

## Meta integration details
- `server/integrations/meta/oauth.js` — authorization URL builder, code
  exchange, and short-lived→long-lived token exchange. No credentials
  hardcoded; everything comes from env vars.
- `server/integrations/meta/api.js` — thin Marketing API wrapper (ad
  accounts, campaigns, insights). All calls originate server-side; the
  frontend never sees a token.
- `server/routes/metaAuth.js` — `/connect` (redirects to Meta's OAuth
  dialog, with CSRF-protecting state stored in the session), `/callback`
  (exchanges the code, stores the token), `/disconnect`, `/status`.
- 7 tools in `server/tools/meta/campaigns.js` under the `meta_ads` skill:
  `list_ad_accounts`, `list_campaigns` (read, no confirmation),
  `create_campaign`, `update_campaign`, `pause_campaign`, `resume_campaign`
  (**all require confirmation** — anything touching budget/spend always
  asks first), `get_campaign_insights` (read). New campaigns are always
  created `PAUSED` regardless of what's requested, so nothing spends by
  accident even after approval.

## Database changes
Extended the existing `integrations` table (additive columns:
`accessToken`, `refreshToken`, `tokenExpiresAt`, `scopes`, `meta`,
`updatedAt`) instead of adding separate `oauth_tokens` /
`integration_connections` tables — same reasoning as Phase 3's knowledge
table: one row per (user, provider) already covers everything these tools
need, and a unique index enforces that. Seeded a `meta_ads` skill.

## API endpoints
- `GET /api/integrations` — catalog + real per-user status (now includes
  `setupRequired` for Meta if your env vars aren't set yet, so the UI can
  explain rather than silently fail)
- `GET /api/integrations/meta/connect` → redirects to Meta
- `GET /api/integrations/meta/callback` → exchanges code, stores connection
- `POST /api/integrations/meta/disconnect`
- `GET /api/integrations/meta/status` → configuration + connection health

## Permission model
`meta.read` (list accounts/campaigns, insights), `meta.write` (create/update
campaign), `meta.manage` (pause/resume). Same enforcement path as every
other phase: the agent needs the `meta_ads` skill enabled, then each tool's
declared permissions are checked, then (for write/manage tools) explicit
user confirmation before anything executes.

## Test results — same honesty note as every phase so far
Every file passes `node --check`. **None of this has been run**, and this
phase specifically **cannot** be tested at all until you've completed the
Meta Developer App setup above and set the three env vars — there's no
path to testing this one without that external step, unlike the AI/search
providers where a missing key just degrades gracefully. Once configured,
please actually walk through: connect, list ad accounts, list campaigns,
draft-create a campaign (confirm it appears PAUSED on Meta's own Ads
Manager, not just in this app), pause/resume, insights, and disconnect.

## Security notes
- Tokens are stored server-side only, never sent to the frontend, never
  logged.
- OAuth state is checked against the session to prevent CSRF on the
  callback.
- Every Meta tool call re-validates the token via `requireValidToken` at
  execution time (not just at connect time) — an expired or disconnected
  integration fails the tool call cleanly rather than silently.
- `create_campaign`/`update_campaign`/`pause_campaign`/`resume_campaign` all
  require confirmation with the specific campaign name/budget/objective
  shown, matching the spec's example exactly.

## Readiness for additional integrations
The pattern is now proven twice (Phase 3's provider-agnostic search, Phase
4's OAuth-based Meta connection) — Gmail, Google Calendar/Drive, and
WooCommerce/WordPress (which you already use for BeautyBees) would each
follow the same shape: a definition, an OAuth or API-key auth module, and a
tools file. WooCommerce/WordPress in particular don't need OAuth at all
(they use application passwords, like your existing Store Manager project),
so those would actually be simpler to add than Meta was.
