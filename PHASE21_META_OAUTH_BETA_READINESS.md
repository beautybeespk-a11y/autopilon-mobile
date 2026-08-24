# Phase 21 — Meta OAuth Beta Readiness Verification

Follow-up to `PHASE21_META_OAUTH_UX_AUDIT.md` (architecture audit, accepted).
This is the pre-beta verification pass requested against that audit. No
backend Meta OAuth code was changed — everything below is either (a) a
new, isolated test file that exercises the existing production code
without modifying it, or (b) documentation. `META_APP_SECRET` was never
read, logged, or displayed by anything below, and the registered Meta
redirect URI was not touched.

## Result summary

| # | Item | Result |
|---|---|---|
| 1 | Meta App Tester requirements for `ads_management` | **PASS — documented** (§1) |
| 2 | Web OAuth flow works with a separate beta/tester Meta account | **EXTERNAL ACTION REQUIRED** (§2) |
| 3 | Connected user's Meta assets/tokens stay isolated to that user | **PASS — actually tested** (§3) |
| 4 | Logout / reconnect / revocation handled correctly | **PASS — actually tested** (§4) |
| 5 | Mobile WebView approach | Kept as-is (per instruction). Build/device test: **EXTERNAL ACTION REQUIRED** (§5) |
| 6 | Mobile Meta OAuth "passed" claim | **NOT TESTED** — not claimed (§5) |
| 7 | No redirect URI change, no secret exposure | **PASS — verified** (§6) |

---

## 1. Meta App Tester requirements for `ads_management` — PASS, documented

The app currently requests exactly two scopes:
`ads_read`, `ads_management` (`server/integrations/meta/oauth.js`, confirmed
again by this session's new `metaOAuthLifecycleRegression.js` test,
"the requested scope is exactly ads_read,ads_management").

Meta gates who can complete an OAuth grant for these scopes by the app's
**Mode** and **Access Level** in the Meta App Dashboard, not by anything in
this codebase:

- **Development Mode (the default for a new/unreviewed app):** only
  Facebook accounts added to the app's **App Roles** — as **Admin**,
  **Developer**, or **Tester** — can complete login and grant
  `ads_management`/`ads_read` to this app. Anyone else hits a Meta-rendered
  "this app isn't available" screen, before our server or UI is even
  involved.
- **Advanced Access via App Review:** to let people who are *not* on the
  App Roles list connect, `ads_management` (and `ads_read` beyond the
  Standard Access default) needs to go through **App Review**, which for
  Marketing API permissions has historically also required
  **Business Verification** of the Meta Business Manager that owns the
  app. Once approved and the app is switched to **Live**, any Facebook
  user can complete the OAuth grant, subject only to Meta's own consent
  screen.

**For a 5–10 person private beta, App Review is very likely unnecessary
right now** — the fast path is adding each beta tester as a Tester:

1. Meta Developer Dashboard → your app → **App Roles → Roles**.
2. **Add People** → **Tester** → enter each beta user's Facebook account
   (name or the email tied to their Facebook account).
3. Each invited person must accept the invite themselves: they'll see it
   at `facebook.com/settings` under **Apps and Websites → Requests** (or
   the direct link Meta emails/shows them) and must click **Accept**.
   Until they accept, their account is invited but not yet authorized —
   Meta's OAuth dialog will still block them.
4. Only after acceptance can that person successfully complete
   **Connect Meta Ads** in the product.

Meta's dashboard labels/navigation shift periodically — confirm the exact
current path in your own App Dashboard rather than relying on this
document's wording being pixel-current.

## 2. Web OAuth flow with a separate beta/tester Meta account — EXTERNAL ACTION REQUIRED

**What this sandbox can and can't do:** there is no `.env` (checked — none
exists at the repo root or under `server/`) and no real
`META_APP_ID`/`META_APP_SECRET`/tester Facebook account available here.
Completing a real OAuth round trip means a real human logging into a real
Facebook account on Meta's real login page — that has to happen with a
real browser, a real tester account, and a real deployed (or tunneled)
instance of this server pointed at the real registered redirect URI. None
of that exists in this build environment, and it shouldn't be simulated
with fake credentials — a live pass here can only come from you actually
running it.

**What WAS verified instead (§3/§4 below):** every piece of *our* code on
this side of that boundary — building the correct authorization URL,
handling Meta's callback, exchanging the code, storing the token, CSRF
state validation — was exercised against real production route handlers
with only Meta's own HTTP response mocked at the boundary. That gives high
confidence our side is correct; it is not the same thing as a live pass.

**What you need to do:**
1. Add a second Facebook account (yours or a colleague's, distinct from
   whatever account was used during original development) as a **Tester**
   on the Meta App Dashboard (§1), and have that account accept the
   invite.
2. Log into the product as a normal user (a second Autopilon account, not
   a platform admin) with a browser logged into that tester Facebook
   account.
3. Go to **Integrations → Meta Ads → Connect**, complete Meta's consent
   screen, and confirm you land back on Integrations with a green
   "Connected" badge.
4. Repeat once more with a *third* Facebook tester account on a *third*
   Autopilon user account, and confirm both stay connected simultaneously
   without interfering with each other (this exercises the same isolation
   §3 covers, but for real, against real facebook.com).

## 3. Per-user Meta token/asset isolation — PASS, actually tested

New test: `server/test/metaOAuthLifecycleRegression.js`
(`npm run test:meta-oauth-lifecycle` from `server/`). Real
`metaAuth.js`/`integrations/manager.js` code, real SQLite DB, real
AES-256-GCM encryption, real express-session cookies for two independent
simulated browser sessions — only `graph.facebook.com`'s HTTP response is
mocked (there is no real Meta App in this sandbox to call). Also re-ran
the existing `server/test/reconnectAndIsolationRegression.js`, whose
isolation logic is provider-agnostic and already covered `meta_ads`
indirectly through the shared `integrations/manager.js` code path.

```
Meta OAuth lifecycle regression suite (real route handlers, provider fetch mocked at the boundary)
PASS  User A: full connect round trip (real /connect + real /callback) succeeds and stores a real connection
PASS  the requested scope is exactly ads_read,ads_management — no broader/unexpected scope was requested
PASS  access token is encrypted at rest — the raw DB column is ciphertext, not the plaintext token
PASS  User B: independent connect round trip succeeds with a DIFFERENT session/cookie than User A's
PASS  isolation: User A and User B have completely separate tokens — neither is retrievable through the other's userId
PASS  isolation: GET /status for User A never reflects User B's connection or vice versa
PASS  logout: destroying User A's session does not disconnect or alter their Meta connection
PASS  post-logout: the old session cookie can no longer authenticate against a protected integrations route
PASS  re-login as User A (fresh session) sees their own connection again, untouched by the logout
PASS  cross-user via shared browser: User B's session was never affected by User A's logout
PASS  disconnect: revokes with Meta (mocked) and clears the local token, without touching User B
PASS  reconnect: User A can connect again with a NEW token; the old token is nowhere retrievable; no duplicate row
PASS  CSRF: a callback with a state that doesn't match the session is rejected, not silently accepted
13/13 Meta OAuth lifecycle checks passed.
```

```
Reconnect + cross-user/cross-org isolation regression suite
15/15 reconnect + isolation checks passed.
```

Confirms: two users' Meta tokens are stored in separate DB rows, never
cross-readable via `getConnection(userId, "meta_ads")`; neither user's raw
access token is ever returned in an API response, even to its own owner;
disconnecting/reconnecting one user's connection never touches another
user's row or count; encryption at rest holds through a full
connect→disconnect→reconnect cycle.

**Not covered by this test (inherent to it being a code-level test, not a
live one):** whether two different *real* Facebook accounts' *actual*
Meta-side ad account lists stay correctly separated — that depends on
Meta returning the right data for each real token, which can only be
confirmed live (§2, step 4).

## 4. Logout / reconnect / revocation — PASS, actually tested

Same two suites as §3 cover this directly:

- **Logout:** `POST /api/auth/logout` destroys the session but the Meta
  connection row is keyed by `userId`, not session — confirmed the
  connection survives logout untouched, the destroyed session cookie is
  correctly rejected (401) by `requireAuth` afterward, and a fresh login
  as the same user sees their connection again.
- **Reconnect:** disconnect → reconnect produces exactly one row (no
  duplicate), the new token is live, the old token is nowhere retrievable
  — both generically (`reconnectAndIsolationRegression.js`, using
  `shopify`/`woocommerce`) and Meta-specifically (`metaOAuthLifecycleRegression.js`).
- **Revocation:** `oauthRevocationRegression.js`'s existing Meta checks
  (re-run this session, still 11/11 passing) confirm `DELETE
  /me/permissions` is called with the token in an `Authorization` header
  (never the URL, never logged), a provider failure still clears the
  local token and is honestly reported (`revoked: false` +
  `revocationError`), and a second disconnect call is a clean no-op rather
  than a re-attempt or error.
- **CSRF:** a callback with a `state` that doesn't match the session's is
  rejected with an error redirect, not silently accepted — new check in
  `metaOAuthLifecycleRegression.js`.

## 5. Mobile — WebView approach kept; NOT TESTED, EXTERNAL ACTION REQUIRED

The in-app WebView implementation from the prior audit is unchanged in
this pass — no mobile code was touched. Per your instruction, mobile Meta
OAuth is **not claimed as passing**. As stated in the original audit: no
Flutter SDK has ever been available in any environment this repo has been
built in, including this one, so `flutter pub get`, compilation, and
on-device behavior remain **completely unverified**. Everything mobile-side
is code-review-level confidence only, not a tested result.

**What you need to do, in order:**
1. On a machine with the Flutter SDK installed, from
   `autopilon_mobile/`: `flutter pub get` — confirm `webview_flutter:
   ^4.10.0` resolves against this project's Flutter/Dart SDK version, and
   fix any version conflict if one surfaces.
2. `flutter build apk --dart-define=API_BASE_URL=https://<your-reachable-server>/api`
   (or `flutter run` against a device/emulator pointed at a real or
   ngrok-tunneled server) — confirm it compiles.
3. Install the APK on a **real Android device** (not just an emulator, for
   at least the final pass) logged in as a normal beta test account.
4. Open **More → Integrations → Meta Ads → Connect**. Confirm: the in-app
   browser opens already signed in (no separate login prompt for our own
   app), loads Meta's real consent screen, and — after approving — the
   in-app browser **closes itself automatically** and the Integrations
   screen shows "Connected" with a snackbar, without a dead-end "you may
   now close this tab" page.
5. Force-quit and reopen the app; confirm Meta Ads still shows
   "Connected" (session cookie + saved connection both persisted).
6. Tap **Disconnect**, confirm it goes back to "Not connected," then
   **Connect** again and confirm reconnect works cleanly a second time.
7. Only once steps 3–6 all pass on a real device should mobile Meta OAuth
   be considered verified.

## 6. Confirmed unchanged

- `META_REDIRECT_URI` / the registered Meta OAuth redirect URI: not
  referenced or modified by anything in this pass.
- `META_APP_SECRET`: read only inside the pre-existing
  `server/integrations/meta/oauth.js`; the new test file sets a fake
  `test_meta_app_secret` env var for its own isolated in-process server
  and never logs or asserts on its value.
- No file under `server/integrations/meta/`, `server/routes/metaAuth.js`,
  or any other Meta OAuth production code path was edited.
- New/changed files this pass: `server/test/metaOAuthLifecycleRegression.js`
  (new test), `server/package.json` (one new `test:meta-oauth-lifecycle`
  script line), this document.
