// Phase 21 — Meta-specific OAuth lifecycle regression: connect / isolate /
// logout / reconnect / revoke, run against the REAL production code
// (metaAuth.js route handlers, integrations/meta/oauth.js token exchange,
// integrations/manager.js storage+encryption, a real SQLite DB, real
// express-session). The only thing mocked is the external boundary —
// graph.facebook.com's HTTP responses — because this sandbox has no real
// Meta App credentials or tester account. Everything on our side of that
// boundary is exercised for real, including the actual authorization-code
// exchange, long-lived-token exchange, and DELETE /me/permissions revoke.
//
// This test answers, with actual passing/failing assertions rather than
// code-reading alone: does OUR server correctly isolate two different
// users' Meta connections, correctly survive a logout/login cycle, and
// correctly disconnect/reconnect without leaking one user's token to
// another? It does NOT and CANNOT answer whether Meta's own OAuth dialog
// renders correctly for a real tester account — that requires a real Meta
// App + a real browser + a real Facebook login, none of which exist here.
//
//   node test/metaOAuthLifecycleRegression.js
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/meta-oauth-lifecycle-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-meta-lifecycle-test";
process.env.META_APP_ID = "test_meta_app_id";
process.env.META_APP_SECRET = "test_meta_app_secret";
process.env.META_REDIRECT_URI = "http://localhost/api/integrations/meta/callback";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { getConnection, connectionHealth } = await import("../integrations/manager.js");
const metaAuthRoutes = (await import("../routes/metaAuth.js")).default;
const authRoutes = (await import("../routes/auth.js")).default;

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

const app = express();
app.use(express.json());
app.use(session({ secret: "test-session-secret-for-meta-lifecycle", resave: false, saveUninitialized: false, cookie: { secure: false } }));
app.use((req, res, next) => {
  const testUserId = req.headers["x-test-user-id"];
  if (testUserId && !req.session.userId) req.session.userId = testUserId;
  next();
});
app.use("/api/auth", authRoutes);
app.use("/api/integrations/meta", metaAuthRoutes);
const server = app.listen(0);
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

function makeUser(email) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO users (id, email, password, name, createdAt) VALUES (?, ?, ?, ?, ?)").run(id, email, "hash", "Test User", new Date().toISOString());
  return id;
}

// A stateful "browser session" — carries cookies across requests exactly
// like a real client would, including across a real /auth/logout call
// (which destroys the session server-side; this client just keeps
// forwarding whatever cookie it was last given, the same way a browser
// would forward a now-invalid cookie until a new one is set).
function makeSession() {
  let cookie = null;
  return {
    async req(method, path, { userId, body, followRedirect = false } = {}) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        redirect: followRedirect ? "follow" : "manual",
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(userId ? { "x-test-user-id": userId } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch { /* redirects/no-body are fine */ }
      return { status: res.status, json, location: res.headers.get("location") };
    },
    get cookie() { return cookie; },
  };
}

const originalFetch = global.fetch;
function mockMetaFetch(accessToken) {
  global.fetch = async (url, opts) => {
    const urlStr = url.toString();
    if (urlStr.startsWith(BASE)) return originalFetch(url, opts);
    // Both the short-lived code->token exchange and the long-lived upgrade
    // hit the same oauth/access_token endpoint — real oauth.js code path,
    // only the network response is faked, shaped exactly like Meta's real
    // Graph API response.
    if (urlStr.includes("/oauth/access_token")) {
      return { ok: true, json: async () => ({ access_token: accessToken, expires_in: 5183944 }) };
    }
    throw new Error(`Unexpected outbound fetch in test: ${urlStr}`);
  };
}
function restoreFetch() {
  global.fetch = originalFetch;
}

// Drives a full /connect -> (fake Meta redirect) -> /callback round trip
// through the REAL route handlers, exactly as a real Facebook redirect
// would, for a given already-authenticated session.
async function connectMeta(sess, userId, fakeAccessToken) {
  const connectRes = await sess.req("GET", "/api/integrations/meta/connect", { userId });
  assert.equal(connectRes.status, 302, "connect issues a redirect to Meta's real OAuth dialog");
  const authUrl = new URL(connectRes.location);
  assert.equal(authUrl.hostname, "www.facebook.com", "redirects to Meta's real domain, not anywhere else");
  const state = authUrl.searchParams.get("state");
  assert.ok(state, "a CSRF state param was generated and included");

  mockMetaFetch(fakeAccessToken);
  try {
    // This is exactly the request Meta itself sends the browser to after
    // the user approves the dialog — same query shape, same session cookie
    // (a real browser carries the cookie across the facebook.com round trip
    // the same way this test client does).
    const callbackRes = await sess.req("GET", `/api/integrations/meta/callback?code=fake-meta-auth-code&state=${state}`, { userId });
    assert.equal(callbackRes.status, 302);
    assert.ok(callbackRes.location.includes("meta_connected=1"), `expected a success redirect, got: ${callbackRes.location}`);
  } finally {
    restoreFetch();
  }
}

const stamp = Date.now();

async function run() {
  console.log("Meta OAuth lifecycle regression suite (real route handlers, provider fetch mocked at the boundary)\n");

  // --- User A connects --------------------------------------------------
  const userA = makeUser(`meta-lifecycle-a-${stamp}@example.com`);
  const sessA = makeSession();
  await check("User A: full connect round trip (real /connect + real /callback) succeeds and stores a real connection", async () => {
    await connectMeta(sessA, userA, `meta-token-user-a-${stamp}`);
    const conn = getConnection(userA, "meta_ads");
    assert.equal(conn.accessToken, `meta-token-user-a-${stamp}`);
    assert.equal(connectionHealth(userA, "meta_ads").connected, true);
  });

  await check("the requested scope is exactly ads_read,ads_management — no broader/unexpected scope was requested", async () => {
    const dummySess = makeSession();
    const res = await dummySess.req("GET", "/api/integrations/meta/connect", { userId: userA });
    const authUrl = new URL(res.location);
    assert.equal(authUrl.searchParams.get("scope"), "ads_read,ads_management");
  });

  await check("access token is encrypted at rest — the raw DB column is ciphertext, not the plaintext token", () => {
    const raw = db.prepare("SELECT accessToken FROM integrations WHERE userId = ? AND provider = 'meta_ads'").get(userA);
    assert.match(raw.accessToken, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, "AES-256-GCM iv:tag:ciphertext format, not plaintext");
    assert.ok(!raw.accessToken.includes(`meta-token-user-a-${stamp}`));
  });

  // --- User B connects with a completely different token -----------------
  const userB = makeUser(`meta-lifecycle-b-${stamp}@example.com`);
  const sessB = makeSession();
  await check("User B: independent connect round trip succeeds with a DIFFERENT session/cookie than User A's", async () => {
    assert.notEqual(sessB.cookie, sessA.cookie);
    await connectMeta(sessB, userB, `meta-token-user-b-${stamp}`);
  });

  await check("isolation: User A and User B have completely separate tokens — neither is retrievable through the other's userId", () => {
    const connA = getConnection(userA, "meta_ads");
    const connB = getConnection(userB, "meta_ads");
    assert.notEqual(connA.id, connB.id, "different rows entirely");
    assert.equal(connA.accessToken, `meta-token-user-a-${stamp}`);
    assert.equal(connB.accessToken, `meta-token-user-b-${stamp}`);
    assert.notEqual(connA.accessToken, connB.accessToken);
  });

  await check("isolation: GET /status for User A never reflects User B's connection or vice versa", async () => {
    const statusA = await sessA.req("GET", "/api/integrations/meta/status", { userId: userA });
    const statusB = await sessB.req("GET", "/api/integrations/meta/status", { userId: userB });
    assert.equal(statusA.json.connection.connected, true);
    assert.equal(statusB.json.connection.connected, true);
    // The status endpoint reports connected/expiry only — never the raw
    // token — confirm neither user's token value leaks into either response.
    const bodyA = JSON.stringify(statusA.json);
    const bodyB = JSON.stringify(statusB.json);
    assert.ok(!bodyA.includes(`meta-token-user-b-${stamp}`));
    assert.ok(!bodyB.includes(`meta-token-user-a-${stamp}`));
    assert.ok(!bodyA.includes(`meta-token-user-a-${stamp}`), "the access token itself is never returned to the client, even for its own owner");
  });

  // --- Logout does NOT touch the stored Meta connection -------------------
  await check("logout: destroying User A's session does not disconnect or alter their Meta connection", async () => {
    const logoutRes = await sessA.req("POST", "/api/auth/logout", { userId: userA });
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.json.ok, true);
    const conn = getConnection(userA, "meta_ads");
    assert.equal(conn.accessToken, `meta-token-user-a-${stamp}`, "the connection is keyed by userId in the DB, not by session — logging out never touches it");
  });

  await check("post-logout: the old session cookie can no longer authenticate against a protected integrations route", async () => {
    // Re-use sessA's (now-destroyed) cookie with no x-test-user-id header —
    // mirrors a real client whose session cookie the server has expired.
    const res = await fetch(`${BASE}/api/integrations/meta/status`, { headers: { Cookie: sessA.cookie } });
    assert.equal(res.status, 401, "requireAuth correctly rejects the destroyed session");
  });

  await check("re-login as User A (fresh session) sees their own connection again, untouched by the logout", async () => {
    const freshSessA = makeSession();
    const res = await freshSessA.req("GET", "/api/integrations/meta/status", { userId: userA });
    assert.equal(res.json.connection.connected, true);
  });

  await check("cross-user via shared browser: User B's session was never affected by User A's logout", async () => {
    const res = await sessB.req("GET", "/api/integrations/meta/status", { userId: userB });
    assert.equal(res.json.connection.connected, true);
  });

  // --- Disconnect / reconnect cycle for User A -----------------------------
  await check("disconnect: revokes with Meta (mocked) and clears the local token, without touching User B", async () => {
    global.fetch = async (url, opts) => {
      const urlStr = url.toString();
      if (urlStr.startsWith(BASE)) return originalFetch(url, opts);
      assert.ok(urlStr.includes("/me/permissions"), "disconnect calls the real Meta de-authorize endpoint");
      assert.equal(opts.method, "DELETE");
      return { ok: true, json: async () => ({ success: true }) };
    };
    const freshSessA = makeSession();
    const res = await freshSessA.req("POST", "/api/integrations/meta/disconnect", { userId: userA });
    restoreFetch();
    assert.equal(res.status, 200);
    assert.equal(res.json.revoked, true);
    assert.equal(getConnection(userA, "meta_ads").accessToken, null);
    assert.equal(getConnection(userB, "meta_ads").accessToken, `meta-token-user-b-${stamp}`, "User B completely unaffected by User A's disconnect");
  });

  await check("reconnect: User A can connect again with a NEW token; the old token is nowhere retrievable; no duplicate row", async () => {
    const reconnectSess = makeSession();
    await connectMeta(reconnectSess, userA, `meta-token-user-a-v2-${stamp}`);
    const conn = getConnection(userA, "meta_ads");
    assert.equal(conn.accessToken, `meta-token-user-a-v2-${stamp}`);
    assert.notEqual(conn.accessToken, `meta-token-user-a-${stamp}`);
    const n = db.prepare("SELECT COUNT(*) AS n FROM integrations WHERE userId = ? AND provider = 'meta_ads'").get(userA).n;
    assert.equal(n, 1, "reconnect updates the existing row, never creates a second one");
  });

  await check("CSRF: a callback with a state that doesn't match the session is rejected, not silently accepted", async () => {
    const sess = makeSession();
    await sess.req("GET", "/api/integrations/meta/connect", { userId: userA }); // seeds a real state in the session
    const res = await sess.req("GET", "/api/integrations/meta/callback?code=whatever&state=an-attacker-guessed-state", { userId: userA });
    assert.ok(res.location.includes("meta_error="), "mismatched state is rejected with an error redirect, not a successful connect");
    assert.ok(res.location.toLowerCase().includes("state"));
  });

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Meta OAuth lifecycle checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Meta OAuth lifecycle regression suite crashed:", err);
  process.exit(1);
});
