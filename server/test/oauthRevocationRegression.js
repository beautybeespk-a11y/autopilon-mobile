// Phase 18.2 §2/§3/§16 — OAuth disconnect revocation regression suite.
// Real code, real HTTP requests — but since this sandbox has no live
// Google/Meta OAuth credentials, the ONLY thing mocked is the external
// provider's own `fetch` response (same boundary-only-mocking approach
// used for the Phase 18.1 WooCommerce Basic Auth test). Everything else
// is the real production code: the real gmailAuth.js/googleServiceAuth.js/
// metaAuth.js route handlers, the real revokeToken() functions, the real
// integrations/manager.js encryption/decryption, a real SQLite DB.
//
// Runs a tiny in-process Express app (session + the three OAuth route
// files) rather than a separately-booted server process, specifically so
// this script's global.fetch monkey-patch is visible to the route
// handlers' own revokeToken() calls — they run in the same process.
//
//   node test/oauthRevocationRegression.js
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/oauth-revocation-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-revocation-test";
process.env.GOOGLE_CLIENT_ID = "test_google_client_id";
process.env.GOOGLE_CLIENT_SECRET = "test_google_client_secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost/api/integrations/gmail/callback";
process.env.META_APP_ID = "test_meta_app_id";
process.env.META_APP_SECRET = "test_meta_app_secret";
process.env.META_REDIRECT_URI = "http://localhost/api/integrations/meta/callback";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { saveConnection, getConnection } = await import("../integrations/manager.js");
const gmailAuthRoutes = (await import("../routes/gmailAuth.js")).default;
const { createGoogleServiceRouter } = await import("../routes/googleServiceAuth.js");
const metaAuthRoutes = (await import("../routes/metaAuth.js")).default;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

// --- tiny in-process app: session + the real OAuth route files ------------
const app = express();
app.use(express.json());
app.use(session({ secret: "test-session-secret-for-revocation-regression", resave: false, saveUninitialized: false, cookie: { secure: false } }));
// Stamps req.session.userId from a test-only header on the first request
// of a session, mirroring what a real login sets — this harness doesn't
// mount /api/auth, and these route files only need req.session.userId
// (all requireAuth checks). Registered BEFORE the OAuth routers so it
// runs first.
app.use((req, res, next) => {
  const testUserId = req.headers["x-test-user-id"];
  if (testUserId && !req.session.userId) req.session.userId = testUserId;
  next();
});
app.use("/api/integrations/gmail", gmailAuthRoutes);
app.use("/api/integrations/google_calendar", createGoogleServiceRouter("google_calendar", "Google Calendar"));
app.use("/api/integrations/meta", metaAuthRoutes);
const server = app.listen(0);
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

function makeUser(email) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO users (id, email, password, name, createdAt) VALUES (?, ?, ?, ?, ?)").run(id, email, "hash", "Test User", new Date().toISOString());
  return id;
}

function makeAuthedSession(userId) {
  let cookie = null;
  return {
    async req(method, path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), "x-test-user-id": userId },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch { /* fine */ }
      return { status: res.status, json };
    },
  };
}

const originalFetch = global.fetch;
// global.fetch is one process-wide reference — the test client below also
// uses it (to reach this script's own local test server), so a naive
// blanket replacement would intercept those calls too, not just the route
// handler's real outbound call to "Google"/"Meta". Only intercept requests
// that are NOT going to this test's own local server.
function mockProviderFetch(handler) {
  global.fetch = async (url, opts) => {
    const urlStr = url.toString();
    if (urlStr.startsWith(BASE)) return originalFetch(url, opts);
    return handler(urlStr, opts);
  };
}
function restoreFetch() {
  global.fetch = originalFetch;
}

function activityRows(userId, action) {
  return db.prepare("SELECT * FROM activity_logs WHERE userId = ? AND action = ? ORDER BY createdAt DESC").all(userId, action);
}

const stamp = Date.now();

async function run() {
  console.log(`OAuth revocation regression suite (in-process, provider fetch mocked at the boundary)\n`);

  // --- Gmail / Google: real Google revoke endpoint construction ---------
  await check("Google revokeToken(): calls the real revoke endpoint with the token in the POST body (never the URL)", async () => {
    const { revokeToken } = await import("../integrations/gmail/oauth.js");
    let captured = null;
    mockProviderFetch(async (url, opts) => {
      captured = { url, opts };
      return { ok: true, json: async () => ({}) };
    });
    try {
      await revokeToken("fake-refresh-token-value");
    } finally { restoreFetch(); }
    assert.equal(captured.url, "https://oauth2.googleapis.com/revoke", "hits Google's real revoke endpoint");
    assert.ok(!captured.url.includes("fake-refresh-token-value"), "token is not in the URL");
    assert.equal(captured.opts.method, "POST");
    const bodyStr = captured.opts.body.toString();
    assert.ok(bodyStr.includes("fake-refresh-token-value"), "token IS sent, but in the POST body, not the URL");
  });

  await check("Google revokeToken(): a 400 invalid_token response is treated as already-revoked success, not a failure", async () => {
    const { revokeToken } = await import("../integrations/gmail/oauth.js");
    mockProviderFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_token" }) }));
    let result;
    try { result = await revokeToken("already-dead-token"); } finally { restoreFetch(); }
    assert.equal(result.revoked, true);
    assert.equal(result.alreadyInvalid, true);
  });

  await check("Google revokeToken(): a genuine provider failure throws, without leaking the token in the error message", async () => {
    const { revokeToken } = await import("../integrations/gmail/oauth.js");
    mockProviderFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: "server_error" }) }));
    let threw = false;
    try {
      await revokeToken("real-token-should-not-leak");
    } catch (err) {
      threw = true;
      assert.ok(!err.message.includes("real-token-should-not-leak"), "error message does not include the token");
    } finally { restoreFetch(); }
    assert.ok(threw, "a genuine 500 is a real thrown failure, not silently swallowed");
  });

  // --- Meta: real de-authorize endpoint construction ----------------------
  await check("Meta revokeToken(): calls DELETE /me/permissions with the token in an Authorization header, never the URL", async () => {
    const { revokeToken } = await import("../integrations/meta/oauth.js");
    let captured = null;
    mockProviderFetch(async (url, opts) => {
      captured = { url, opts };
      return { ok: true, json: async () => ({ success: true }) };
    });
    try {
      await revokeToken("fake-meta-access-token");
    } finally { restoreFetch(); }
    assert.ok(captured.url.includes("/me/permissions"), "hits the real de-authorize endpoint");
    assert.ok(!captured.url.includes("fake-meta-access-token"), "token is not in the URL");
    assert.equal(captured.opts.method, "DELETE");
    assert.equal(captured.opts.headers.authorization, "Bearer fake-meta-access-token", "token is sent as a Bearer header instead");
  });

  await check("Meta revokeToken(): a provider error response throws without leaking the token", async () => {
    const { revokeToken } = await import("../integrations/meta/oauth.js");
    mockProviderFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Invalid OAuth access token." } }) }));
    let threw = false;
    try {
      await revokeToken("real-meta-token-should-not-leak");
    } catch (err) {
      threw = true;
      assert.ok(!err.message.includes("real-meta-token-should-not-leak"));
    } finally { restoreFetch(); }
    assert.ok(threw);
  });

  // --- End-to-end disconnect route behavior --------------------------------
  const userA = makeUser(`revoke-a-${stamp}@example.com`);
  saveConnection(userA, "gmail", { accessToken: "real-gmail-access-token", refreshToken: "real-gmail-refresh-token", expiresAt: null, scopes: [], meta: {} });

  await check("disconnect: successful provider revocation is reported honestly and local credentials are cleared", async () => {
    mockProviderFetch(async () => ({ ok: true, json: async () => ({}) }));
    const sess = makeAuthedSession(userA);
    const { status, json } = await sess.req("POST", "/api/integrations/gmail/disconnect");
    restoreFetch();
    assert.equal(status, 200);
    assert.equal(json.revoked, true);
    assert.equal(json.revocationError, null);
    const conn = getConnection(userA, "gmail");
    assert.equal(conn.accessToken, null, "local access token is cleared");
    assert.equal(conn.refreshToken, null, "local refresh token is cleared");
  });

  const userB = makeUser(`revoke-b-${stamp}@example.com`);
  saveConnection(userB, "gmail", { accessToken: "real-gmail-access-token-2", refreshToken: "real-gmail-refresh-token-2", expiresAt: null, scopes: [], meta: {} });

  await check("disconnect: a FAILED provider revocation still clears local credentials, reports honestly, and logs integration_revocation_failed", async () => {
    mockProviderFetch(async () => ({ ok: false, status: 503, json: async () => ({ error: "service_unavailable" }) }));
    const sess = makeAuthedSession(userB);
    const { status, json } = await sess.req("POST", "/api/integrations/gmail/disconnect");
    restoreFetch();
    assert.equal(status, 200, "the disconnect endpoint itself still succeeds even though the provider call failed");
    assert.equal(json.revoked, false, "honestly reports the provider revocation did NOT succeed");
    assert.ok(json.revocationError, "a revocation error message is present");
    const conn = getConnection(userB, "gmail");
    assert.equal(conn.accessToken, null, "local credentials are cleared regardless — a failed provider call is never a reason to leave them usable");
    assert.equal(conn.refreshToken, null);
    const failureLogs = activityRows(userB, "integration_revocation_failed");
    assert.ok(failureLogs.length >= 1, "a integration_revocation_failed audit event was recorded");
    assert.ok(!failureLogs[0].description.includes("real-gmail-access-token-2") && !failureLogs[0].description.includes("real-gmail-refresh-token-2"), "the audit log description never contains the token value");
  });

  const userC = makeUser(`revoke-c-${stamp}@example.com`);
  await check("disconnect: with no prior connection, nothing is revoked (revoked: null), and disconnect still succeeds cleanly", async () => {
    const sess = makeAuthedSession(userC);
    const { status, json } = await sess.req("POST", "/api/integrations/gmail/disconnect");
    assert.equal(status, 200);
    assert.equal(json.revoked, null, "there was no token to revoke, so this is honestly null, not false");
  });

  const userD = makeUser(`revoke-d-${stamp}@example.com`);
  saveConnection(userD, "meta_ads", { accessToken: "real-meta-access-token", expiresAt: null, scopes: [] });
  await check("Meta disconnect: successful de-authorization is reported honestly and local credentials are cleared", async () => {
    mockProviderFetch(async () => ({ ok: true, json: async () => ({ success: true }) }));
    const sess = makeAuthedSession(userD);
    const { status, json } = await sess.req("POST", "/api/integrations/meta/disconnect");
    restoreFetch();
    assert.equal(status, 200);
    assert.equal(json.revoked, true);
    const conn = getConnection(userD, "meta_ads");
    assert.equal(conn.accessToken, null);
  });

  const userE = makeUser(`revoke-e-${stamp}@example.com`);
  saveConnection(userE, "google_calendar", { accessToken: "real-calendar-access-token", refreshToken: "real-calendar-refresh-token", expiresAt: null, scopes: [], meta: {} });
  await check("Google Calendar disconnect (via the shared service-router factory): revocation wiring works identically to Gmail", async () => {
    mockProviderFetch(async () => ({ ok: true, json: async () => ({}) }));
    const sess = makeAuthedSession(userE);
    const { status, json } = await sess.req("POST", "/api/integrations/google_calendar/disconnect");
    restoreFetch();
    assert.equal(status, 200);
    assert.equal(json.revoked, true);
    const conn = getConnection(userE, "google_calendar");
    assert.equal(conn.accessToken, null);
  });

  // --- Idempotent disconnect (Phase 18.2 §17 preview — full concurrency
  // suite is a separate file, this is the simple double-call case scoped
  // to revocation specifically) ---
  await check("disconnect: calling it a second time after already disconnected does not re-attempt revocation or error", async () => {
    let fetchCallCount = 0;
    mockProviderFetch(async () => { fetchCallCount++; return { ok: true, json: async () => ({}) }; });
    const sess = makeAuthedSession(userA); // userA was already disconnected above
    const { status, json } = await sess.req("POST", "/api/integrations/gmail/disconnect");
    restoreFetch();
    assert.equal(status, 200, "disconnecting an already-disconnected integration does not error");
    assert.equal(json.revoked, null, "no token existed to revoke the second time");
    assert.equal(fetchCallCount, 0, "the provider was not even contacted — there was nothing to revoke");
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OAuth revocation checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("OAuth revocation regression suite crashed:", err);
  process.exit(1);
});
