// Phase 18.2 §7 — token refresh safety regression. Real production code
// (integrations/gmail/api.js's checkConnection() -> getValidAccessToken(),
// integrations/manager.js's saveConnection/getConnection/encryption).
// Only Google's own token/API endpoints are mocked at the fetch boundary
// (no live Google credentials in this sandbox) — everything else is real.
//
//   node test/tokenRefreshSafetyRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/token-refresh-safety-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-refresh-test";
process.env.GOOGLE_CLIENT_ID = "test_google_client_id";
process.env.GOOGLE_CLIENT_SECRET = "test_google_client_secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost/api/integrations/gmail/callback";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { saveConnection, getConnection, disconnectIntegration } = await import("../integrations/manager.js");
const { checkConnection } = await import("../integrations/gmail/api.js");

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

function makeUser(email) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO users (id, email, password, name, createdAt) VALUES (?, ?, ?, ?, ?)").run(id, email, "hash", "Test User", new Date().toISOString());
  return id;
}

const originalFetch = global.fetch;
function mockFetch(handler) {
  global.fetch = async (url, opts) => handler(url.toString(), opts);
}
function restoreFetch() {
  global.fetch = originalFetch;
}

function profileResponse() {
  return { ok: true, json: async () => ({ emailAddress: "test@example.com", messagesTotal: 42 }) };
}

const stamp = Date.now();
const inTheFuture = () => new Date(Date.now() + 3600_000).toISOString();
const inThePast = () => new Date(Date.now() - 3600_000).toISOString();

async function run() {
  console.log("Token refresh safety regression suite\n");

  // --- 1. Valid (non-expired) access token: no refresh call is made ------
  const user1 = makeUser(`refresh-valid-${stamp}@example.com`);
  saveConnection(user1, "gmail", { accessToken: "still-valid-token", refreshToken: "refresh-token-1", expiresAt: inTheFuture(), scopes: [], meta: {} });
  await check("valid access token: no refresh call is made, the existing token is used directly", async () => {
    let tokenEndpointHit = false;
    mockFetch(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) tokenEndpointHit = true;
      return profileResponse();
    });
    await checkConnection(user1);
    restoreFetch();
    assert.equal(tokenEndpointHit, false, "the refresh endpoint was never contacted for a still-valid token");
  });

  // --- 2. Expired access token: refresh happens, new token is persisted --
  const user2 = makeUser(`refresh-expired-${stamp}@example.com`);
  saveConnection(user2, "gmail", { accessToken: "old-expired-token", refreshToken: "refresh-token-2", expiresAt: inThePast(), scopes: [], meta: {} });
  await check("expired access token: refresh happens automatically and the new token is persisted", async () => {
    mockFetch(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) return { ok: true, json: async () => ({ access_token: "fresh-token-2", expires_in: 3600 }) };
      return profileResponse();
    });
    await checkConnection(user2);
    restoreFetch();
    const conn = getConnection(user2, "gmail");
    assert.equal(conn.accessToken, "fresh-token-2");
    assert.equal(conn.refreshToken, "refresh-token-2", "Google doesn't reissue the refresh token — the original is kept");
  });

  await check("refreshed access token is encrypted at rest, not stored as plaintext", () => {
    const raw = db.prepare("SELECT accessToken FROM integrations WHERE userId = ? AND provider = 'gmail'").get(user2);
    assert.notEqual(raw.accessToken, "fresh-token-2");
    assert.match(raw.accessToken, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  // --- 3. Refresh failure: the old (already-expired) token is NOT overwritten with garbage --
  const user3 = makeUser(`refresh-failure-${stamp}@example.com`);
  saveConnection(user3, "gmail", { accessToken: "old-token-should-survive", refreshToken: "refresh-token-3", expiresAt: inThePast(), scopes: [], meta: {} });
  await check("refresh failure: the call throws cleanly and does not overwrite the existing (expired) credential with invalid data", async () => {
    mockFetch(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) return { ok: false, status: 500, text: async () => '{"error":"server_error"}' };
      return profileResponse();
    });
    let threw = false;
    try {
      await checkConnection(user3);
    } catch (err) {
      threw = true;
    } finally { restoreFetch(); }
    assert.ok(threw, "checkConnection() throws when refresh fails, rather than silently succeeding");
    const conn = getConnection(user3, "gmail");
    assert.equal(conn.accessToken, "old-token-should-survive", "the prior (expired, but not corrupted) access token is untouched");
    assert.equal(conn.refreshToken, "refresh-token-3", "the prior refresh token is untouched");
  });

  // --- 4. Revoked refresh token: same failure path, not silently ignored --
  const user4 = makeUser(`refresh-revoked-${stamp}@example.com`);
  saveConnection(user4, "gmail", { accessToken: "old-token-4", refreshToken: "revoked-refresh-token-4", expiresAt: inThePast(), scopes: [], meta: {} });
  await check("revoked refresh token: Google's invalid_grant is a real failure, not silently treated as success", async () => {
    mockFetch(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) return { ok: false, status: 400, text: async () => '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}' };
      return profileResponse();
    });
    let threw = false;
    let errorMessage = "";
    try {
      await checkConnection(user4);
    } catch (err) {
      threw = true;
      errorMessage = err.message;
    } finally { restoreFetch(); }
    assert.ok(threw);
    assert.ok(!errorMessage.includes("revoked-refresh-token-4"), "the refresh token value never appears in the thrown error message");
    const conn = getConnection(user4, "gmail");
    assert.equal(conn.accessToken, "old-token-4", "no corruption — the old (unusable but not garbage) credential is left alone");
  });

  // --- 5. Concurrent refresh attempts: both complete without corrupting state --
  const user5 = makeUser(`refresh-concurrent-${stamp}@example.com`);
  saveConnection(user5, "gmail", { accessToken: "old-token-5", refreshToken: "refresh-token-5", expiresAt: inThePast(), scopes: [], meta: {} });
  await check("concurrent refresh attempts: both complete successfully and the final DB state is a valid, consistent connection (not corrupted)", async () => {
    let refreshCallCount = 0;
    mockFetch(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        refreshCallCount++;
        const n = refreshCallCount;
        return { ok: true, json: async () => ({ access_token: `concurrent-fresh-token-${n}`, expires_in: 3600 }) };
      }
      return profileResponse();
    });
    const [r1, r2] = await Promise.allSettled([checkConnection(user5), checkConnection(user5)]);
    restoreFetch();
    assert.equal(r1.status, "fulfilled", "the first concurrent call succeeds");
    assert.equal(r2.status, "fulfilled", "the second concurrent call succeeds");
    const conn = getConnection(user5, "gmail");
    assert.ok(conn.accessToken === "concurrent-fresh-token-1" || conn.accessToken === "concurrent-fresh-token-2", "the final persisted token is one of the two real refreshed values — not corrupted, truncated, or double-encrypted");
    assert.equal(conn.refreshToken, "refresh-token-5", "the refresh token itself is untouched by either concurrent write");
  });

  // --- 6. Disconnect during refresh: must NOT resurrect the connection ----
  const user6 = makeUser(`refresh-disconnect-race-${stamp}@example.com`);
  saveConnection(user6, "gmail", { accessToken: "old-token-6", refreshToken: "refresh-token-6", expiresAt: inThePast(), scopes: [], meta: {} });
  await check("disconnect while a refresh is in flight: the refresh does not resurrect the connection afterward", async () => {
    mockFetch(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        // Simulates the real race: the user's disconnect request completes
        // (synchronously, on this same single thread) WHILE this refresh's
        // network call is the one thing still pending — exactly what
        // "await refreshAccessToken(...)" yielding control makes possible
        // in the real app.
        disconnectIntegration(user6, "gmail");
        return { ok: true, json: async () => ({ access_token: "should-never-be-persisted", expires_in: 3600 }) };
      }
      return profileResponse();
    });
    let threw = false;
    let code = null;
    try {
      await checkConnection(user6);
    } catch (err) {
      threw = true;
      code = err.code;
    } finally { restoreFetch(); }
    assert.ok(threw, "the call fails — it does not silently succeed using a token for a connection that no longer exists");
    assert.equal(code, "INTEGRATION_NOT_CONNECTED");
    const conn = getConnection(user6, "gmail");
    assert.equal(conn.accessToken, null, "the connection was NOT resurrected — it stays fully disconnected");
    assert.equal(conn.refreshToken, null, "the old refresh token was NOT restored either");
    const raw = db.prepare("SELECT accessToken FROM integrations WHERE userId = ? AND provider = 'gmail'").get(user6);
    assert.ok(!raw.accessToken || !raw.accessToken.includes("should-never-be-persisted"), "the refreshed-but-discarded token never touched the database");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} token refresh safety checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Token refresh safety regression suite crashed:", err);
  process.exit(1);
});
