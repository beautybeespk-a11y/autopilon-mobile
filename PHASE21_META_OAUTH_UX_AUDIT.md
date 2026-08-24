# Phase 21 — Meta OAuth User Experience Audit

Audited before Phase 21 beta testing, at the platform owner's request, to
verify that a normal beta user never has to create their own Meta
Developer App or perform any Meta developer configuration.

## Verdict

**The server and web client were already architected correctly.** There is
exactly one platform-wide Meta App, owned and configured once by the
platform owner (you), via three server-only env vars. No end-user-facing
code path — web or, until this audit, mobile — ever asks a user for a Meta
App ID or App Secret, and none did before this change either.

**The actual gap was mobile-only: the Flutter app's Integrations screen was
an unbuilt placeholder** (`Text('Integrations are coming in a later
phase.')` — `autopilon_mobile/lib/features/integrations/presentation/
integrations_screen.dart`, pre-audit). A brand-new mobile beta user had no
way to connect Meta at all — not because it required developer setup, but
because the screen didn't exist yet. This audit implements it, reusing the
existing server-side OAuth flow verbatim (zero backend changes, zero
change to the registered Meta redirect URI).

---

## 1. What was already correct (verified by reading the code, not docs)

| Requirement | Status | Where |
|---|---|---|
| Single platform-wide Meta App, not one per user | ✅ | `server/integrations/meta/oauth.js` reads `META_APP_ID`/`META_APP_SECRET`/`META_REDIRECT_URI` from `process.env` only — set once, server-side |
| App Secret never reaches a client | ✅ | Secret is referenced only in `server/integrations/meta/oauth.js` (token exchange) and `server/routes/whatsappWebhook.js` (HMAC verification) — never in any `res.json()`, never in `client/src/` or `autopilon_mobile/lib/` |
| No end-user form for App ID/Secret | ✅ | `client/src/pages/Integrations.jsx`'s `MANUAL_FIELDS` covers WhatsApp/WordPress/WooCommerce/Shopify only; Meta is `connectType: "redirect"`, a single "Connect" button, no fields at all |
| User-specific OAuth tokens, isolated per user | ✅ | `integrations` table, unique index `(userId, provider)` for personal connections and `(orgId, provider)` for org-shared ones (`server/db.js`) |
| Tokens encrypted at rest | ✅ | AES-256-GCM via `server/orchestrator/secretsCrypto.js`, applied in `saveConnection`/`saveOrgConnection` (`server/integrations/manager.js`) |
| CSRF-protected redirect flow | ✅ | Random `state` stashed in session on `/connect`, checked on `/callback` (`server/routes/metaAuth.js`) |
| Fixed, platform-registered redirect URI | ✅ | `META_REDIRECT_URI` is a single env var, never derived from the incoming request — protects against open-redirect/host-header attacks (confirmed in `PHASE18_10_OAUTH_BILLING_ADMIN_REVIEW.md`'s verified-correct section) |
| Real token revocation on disconnect | ✅ | `DELETE /me/permissions` (`server/integrations/meta/oauth.js:revokeToken`) — de-authorizes the whole grant, then wipes the local row |
| Long-lived tokens | ✅ | Short-lived code exchange is immediately upgraded via `fb_exchange_token` (~60 days) |

One thing worth being precise about: `server/integrations/meta/oauth.js`'s
top comment — *"every value comes from env vars the user sets after
creating their own Meta App"* — and `.env.example`'s *"create your own app
at developers.facebook.com"* are addressed to **the person deploying the
platform** (confirmed by `install-production.sh`, which prompts the
*installer* for these values, and `EXTERNAL_INFRASTRUCTURE.md`, which lists
"a real Meta developer app" as platform infrastructure, alongside things
like the domain and Redis instance). They read ambiguously in isolation;
nothing in the actual request/response path treats an end user this way.

## 2. The one real gap, and what was built

**Before this change:** `autopilon_mobile/lib/features/integrations/
presentation/integrations_screen.dart` was a static placeholder with no
API calls, no Connect button, nothing wired up. Even though the backend
was ready, a mobile beta user had no UI to reach it.

**Why a straight port of the web pattern doesn't work on mobile:** the web
client connects Meta with `window.location.href = connectPath` — a full
page navigation, which works because a browser tab is exactly the kind of
thing the OAuth redirect dance expects to land back on. A Flutter app has
no equivalent "current page" for Meta (or our own server) to redirect back
to, and there's no bearer-token auth to fall back on: `server/middleware.js`
`requireAuth` reads `req.session.userId`, gated on the same
`autopilon.sid` session cookie a browser sends — confirmed in
`autopilon_mobile/lib/core/api/api_client.dart`'s own header comment,
which already carries a persistent cookie jar for this exact reason.

**What was built:** an in-app WebView that:
1. Copies the app's existing session cookie into the WebView's separate
   cookie store, scoped to our own API host only.
2. Loads the server's own `/api/integrations/meta/connect` URL — same
   route the web client hits, unmodified.
3. Lets the WebView navigate through Meta's real OAuth dialog and back to
   our server's `/callback` exactly as it does for web — this is standard
   Meta OAuth happening in Meta's own UI, not anything we render.
4. Detects the server's redirect back to `/app/integrations` (the same
   target the web client already uses) and closes itself, returning
   success/failure to the integrations screen, which reloads real status
   from the server.

**Explicitly not changed, and not needed:**
- `META_REDIRECT_URI` / the Meta App Dashboard's registered redirect URI —
  Meta still only ever redirects to the server's own callback route, never
  to the device. No custom URL scheme, Android intent-filter, or iOS
  Associated Domains entry was added or is required.
- Any backend route, scope, or token-handling code.
- The App Secret's reach — it's read in exactly the same one server file
  as before.

### Files touched

- `autopilon_mobile/pubspec.yaml` — added `webview_flutter` (the only new
  dependency; everything else reuses the existing Dio/cookie-jar stack).
- `autopilon_mobile/lib/core/api/api_client.dart` — added `sessionCookies()`,
  a read-only accessor into the existing cookie jar (no change to how
  cookies are stored or sent for normal API calls).
- `autopilon_mobile/lib/features/integrations/data/integration_models.dart`,
  `manual_connect_fields.dart`, `integration_repository.dart` — data layer
  matching the server's real `GET /api/integrations` catalog shape.
- `autopilon_mobile/lib/features/integrations/providers/integration_provider.dart`
  — Riverpod state, same pattern as `billing_provider.dart`.
- `autopilon_mobile/lib/features/integrations/presentation/
  oauth_connect_webview_screen.dart` — the WebView flow described above.
  Written generically (keyed off `connectType: "redirect"` + `connectPath`
  from the catalog), so it also covers Gmail/Google Calendar/Drive/Docs/
  Sheets, not just Meta — those had the identical mobile gap.
- `autopilon_mobile/lib/features/integrations/presentation/
  integrations_screen.dart` — rewritten from the placeholder into a real
  screen: connect (redirect via WebView, or manual via an inline form for
  WhatsApp/WordPress/WooCommerce/Shopify — same fields as
  `client/src/pages/Integrations.jsx`'s `MANUAL_FIELDS`, still none of them
  Meta App ID/Secret), disconnect, "needs setup by the app owner" notice,
  "coming soon" / "managed by your organization" states.

### Not done, and why

No Flutter SDK has ever been available in any environment this repo has
been built in (confirmed by `autopilon_mobile/lib/core/config/
app_config.dart`'s own comment) — that was true before this change and is
still true in this sandbox. The Dart code above was written carefully,
following this codebase's existing conventions file-for-file (same
Riverpod `StateNotifier`/`ApiResult` pattern as `billing_provider.dart`,
same `Card`/`ListView.separated` layout as `marketplace_installs_screen.dart`),
but **it has not been run through `flutter pub get` or a real build**.
Before this ships to beta testers, someone with a Flutter toolchain needs
to:
1. Run `flutter pub get` and confirm `webview_flutter: ^4.10.0` resolves
   against this project's Flutter SDK version.
2. Build and manually run the Connect flow once against a real (or ngrok-
   tunneled) server, on both a fresh account and an already-connected one,
   confirming the WebView actually closes and the list refreshes.
3. Wire the `android/` (and, once scaffolded, `ios/`) platform folders'
   `INTERNET` permission is already present — no manifest changes were
   required — but this should be re-verified once a real build runs.

---

## 3. Meta requirements that cannot be removed from the user flow

These are Meta's own requirements, not this app's — no UI change on our
side can hide them.

1. **Meta's own consent screen.** Once "Connect" is tapped, the user leaves
   our UI for Meta's `dialog/oauth` page (or, in the WebView, Meta's page
   rendered inside it) and authenticates with their own Facebook
   credentials there. We never see that password.
2. **The `ads_management` scope requires Meta App Review for a public
   audience.** Today the app is likely in Meta's "Development" mode, which
   means **only users added as Admins/Developers/Testers on the Meta App
   Dashboard can complete this OAuth flow at all** — anyone else hits a
   Meta-rendered "this app isn't available" screen, regardless of anything
   in this codebase. Before inviting beta testers who aren't already on
   that Dashboard's role list, the platform owner needs to either:
   - add each beta tester's Facebook account as a Tester on the Meta App
     Dashboard (fine for a small, known beta cohort), or
   - submit the app for Meta App Review on `ads_management`/`ads_read` and
     switch it to Live mode (required before a general/public rollout).
   This was already called out in `PHASE4_NOTES.md` at the time the
   integration was first built; it's restated here because it directly
   gates Phase 21 beta testing and is easy to miss.
3. **Asset-level authorization happens on Meta's side, and its shape
   depends on scopes actually requested.** Today the app requests only
   `ads_read` and `ads_management` (`server/integrations/meta/oauth.js`) —
   no `pages_show_list`, `instagram_basic`, or `business_management`. With
   only these ads scopes, Meta's classic OAuth dialog does not present a
   separate "pick a Page / Instagram account / Business" screen; granting
   the permission gives the app access to every ad account the
   authorizing user administers, and **ad account selection happens later,
   in-product**, when an agent calls `list_ad_accounts`
   (`server/tools/meta/campaigns.js`) and the user (or agent, on their
   behalf) picks which returned ad account to act on. If Pages, Instagram,
   or broader Business asset access is added in a future phase, Meta's
   current Business Login flow does insert an explicit asset-picker step
   into its own dialog for those scopes — that step will appear
   automatically and cannot be skipped or replaced with our own UI.
4. **Long-lived tokens still expire (~60 days) and can be revoked by the
   user on Facebook's own end,** independent of anything happening in this
   app. The existing `connectionHealth`/`disconnect` handling already
   covers a token going invalid; nothing new needed here.

None of the above requires a user to create a Meta Developer App, generate
an App ID/Secret, or touch a Meta App Dashboard as a developer — those
stay entirely the platform owner's one-time responsibility. Items 2–3 are
about who Meta lets through the door and what Meta itself asks for, not
about developer setup.

---

## 4. Exact step-by-step experience for a brand-new beta user

### Web (`client/src/pages/Integrations.jsx` — unchanged, already correct)

1. User logs in, opens **Integrations**.
2. Sees a **Meta Ads** card: "Not connected."
3. Taps **Connect** → full-page redirect to our server's
   `/api/integrations/meta/connect`.
4. Server redirects to Meta's real OAuth dialog
   (`facebook.com/v19.0/dialog/oauth`).
5. User logs into Facebook (if not already) and reviews/approves the
   `ads_read`/`ads_management` permissions on Meta's own screen. *(Gated
   by Meta App Review / Tester-list status — see §3.2.)*
6. Meta redirects back to our server's `/callback`; server exchanges the
   code, upgrades to a long-lived token, saves it encrypted against this
   user's account, redirects to `/app/integrations?meta_connected=1`.
7. User is back on our Integrations page: green **"Connected"** badge,
   banner "Meta Ads connected."
8. Later, when an agent needs a specific ad account, it lists the ones the
   user authorized and the user (or agent) picks one — no separate
   "select assets" screen in the connect flow itself.

### Mobile (new, this change)

1. User logs in, opens **More → Integrations**.
2. Sees a **Meta Ads** card: "Not connected."
3. Taps **Connect** → an in-app browser opens, titled "Connect Meta Ads,"
   already signed in as them (their existing app session cookie carries
   over) and loads our server's `/connect` route.
4. Server redirects it to Meta's real OAuth dialog, rendered inside that
   in-app browser.
5. User logs into Facebook (if not already) and reviews/approves the
   permissions — identical Meta-controlled screen as web. *(Same App
   Review / Tester-list gating as §3.2.)*
6. Meta redirects back to our server's `/callback`; same server-side
   token exchange and encrypted save as web.
7. The in-app browser detects it has landed back on our integrations page
   and **closes itself automatically** — no dead-end "you may now close
   this tab" screen.
8. User is back on the native Integrations screen: green "Connected"
   badge, a confirmation snackbar "Meta Ads connected."
9. Ad account selection happens later, the same way as web — in the chat/
   agent flow, on demand.

At no point in either flow does the user see, enter, or need a Meta App
ID, App Secret, or Meta App Dashboard of their own.
