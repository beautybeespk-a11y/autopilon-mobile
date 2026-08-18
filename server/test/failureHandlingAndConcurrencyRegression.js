// Phase 18.2 §16/§17/§18 — provider failure-mode handling, idempotent
// disconnect, and concurrent-operation safety. Real production code
// (integrations/manager.js, gmail/oauth.js's revokeToken(), the Job
// Manager); only the external provider's fetch is mocked.
//
//   node test/failureHandlingAndConcurrencyRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/failure-handling-concurrency-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-failure-test";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { saveConnection, getConnection, disconnectIntegration } = await import("../integrations/manager.js");
const { revokeToken } = await import("../integrations/gmail/oauth.js");
const { createJob, getJob, processJobsTick, registerJobHandler } = await import("../jobs/jobManager.js");

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
function mockFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = originalFetch; }

const stamp = Date.now();

// A minimal real job handler, structured like every real one in
// jobs/handlers.js — resolves credentials at run time via the real
// manager.js function, same pattern used in Task 90's suite.
registerJobHandler("test.reconnect_probe", async (payload) => {
  const { requireValidToken } = await import("../integrations/manager.js");
  return { tokenLength: requireValidToken(payload.userId, payload.provider).length };
});

async function run() {
  console.log("Failure handling + concurrency regression suite\n");

  // --- §16: provider failure modes -----------------------------------
  await check("provider returns 401: a real, thrown failure (not silently treated as success)", async () => {
    mockFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }));
    let threw = false;
    try { await revokeToken("some-token"); } catch { threw = true; } finally { restoreFetch(); }
    assert.ok(threw);
  });

  await check("provider returns 403: a real, thrown failure", async () => {
    mockFetch(async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden" }) }));
    let threw = false;
    try { await revokeToken("some-token"); } catch { threw = true; } finally { restoreFetch(); }
    assert.ok(threw);
  });

  await check("network failure (fetch itself rejects, not just a non-ok response): handled safely, not an unhandled crash", async () => {
    mockFetch(async () => { throw new TypeError("fetch failed"); }); // real Node fetch's own error shape for a DNS/connection failure
    let threw = false;
    let code = null;
    try { await revokeToken("some-token"); } catch (err) { threw = true; code = err.code; } finally { restoreFetch(); }
    assert.ok(threw, "a network-level failure is a real, catchable error");
    assert.equal(code, "NETWORK_ERROR");
  });

  await check("provider times out: the AbortController wiring correctly turns an abort into a clean TIMEOUT error", async () => {
    // Simulates the real timeout mechanism firing (rather than waiting out
    // the real 10s bound, which would make this suite slow for no extra
    // real coverage) — confirms fetch is actually called WITH an abort
    // signal, and that revokeToken() correctly classifies an AbortError.
    mockFetch(async (url, opts) => {
      assert.ok(opts.signal instanceof AbortSignal, "revokeToken() passes a real AbortSignal to fetch — the timeout is actually wired up, not just present in a comment");
      const err = new DOMException("The operation was aborted.", "AbortError");
      throw err;
    });
    let threw = false;
    let code = null;
    try { await revokeToken("some-token"); } catch (err) { threw = true; code = err.code; } finally { restoreFetch(); }
    assert.ok(threw);
    assert.equal(code, "TIMEOUT");
  });

  await check("invalid/malformed token: rejected as a real failure, never silently accepted", async () => {
    mockFetch(async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_request" }) })); // NOT the invalid_token success-case
    let threw = false;
    try { await revokeToken("garbage"); } catch { threw = true; } finally { restoreFetch(); }
    assert.ok(threw, "a 400 that is NOT specifically invalid_token is a real failure, not treated as already-revoked");
  });

  // --- §17: idempotent disconnect --------------------------------------
  const userA = makeUser(`concurrency-a-${stamp}@example.com`);
  saveConnection(userA, "shopify", { accessToken: `real-token-${stamp}`, expiresAt: null, scopes: [], meta: {} });

  await check("disconnect called twice sequentially: no error, no credential resurrection, consistent final state", () => {
    disconnectIntegration(userA, "shopify");
    disconnectIntegration(userA, "shopify"); // second call — must not throw or misbehave
    const conn = getConnection(userA, "shopify");
    assert.equal(conn.accessToken, null);
    assert.equal(conn.status, "not_connected");
  });

  const userB = makeUser(`concurrency-b-${stamp}@example.com`);
  saveConnection(userB, "shopify", { accessToken: `real-token-b-${stamp}`, expiresAt: null, scopes: [], meta: {} });

  await check("disconnect called simultaneously from two concurrent requests: no crash, no duplicate destructive errors, consistent final state", async () => {
    const results2 = await Promise.allSettled([
      Promise.resolve().then(() => disconnectIntegration(userB, "shopify")),
      Promise.resolve().then(() => disconnectIntegration(userB, "shopify")),
    ]);
    assert.ok(results2.every((r) => r.status === "fulfilled"), "neither concurrent call threw");
    const conn = getConnection(userB, "shopify");
    assert.equal(conn.accessToken, null);
    assert.equal(conn.status, "not_connected");
  });

  // --- §18: concurrent operations ---------------------------------------
  const userC = makeUser(`concurrency-c-${stamp}@example.com`);
  saveConnection(userC, "shopify", { accessToken: `original-token-${stamp}`, expiresAt: null, scopes: [], meta: {} });

  await check("connect + disconnect race: whichever runs last wins cleanly — never a corrupted half-state", () => {
    // saveConnection (reconnect with a new token) and disconnectIntegration
    // are both synchronous, better-sqlite3-backed writes — no async gap
    // between them for a real race window, so this proves the DB-level
    // guarantee directly: running them back-to-back in either order always
    // leaves a fully consistent row, never a mix of old+new fields.
    saveConnection(userC, "shopify", { accessToken: `reconnected-token-${stamp}`, expiresAt: null, scopes: [], meta: {} });
    disconnectIntegration(userC, "shopify");
    let conn = getConnection(userC, "shopify");
    assert.equal(conn.accessToken, null);
    assert.equal(conn.status, "not_connected");

    disconnectIntegration(userC, "shopify");
    saveConnection(userC, "shopify", { accessToken: `reconnected-token-2-${stamp}`, expiresAt: null, scopes: [], meta: {} });
    conn = getConnection(userC, "shopify");
    assert.equal(conn.accessToken, `reconnected-token-2-${stamp}`);
    assert.equal(conn.status, "connected");
  });

  const userD = makeUser(`concurrency-d-${stamp}@example.com`);
  saveConnection(userD, "shopify", { accessToken: `old-worker-token-${stamp}`, expiresAt: null, scopes: [], meta: {} });
  const jobQueuedBeforeReconnect = createJob({ type: "test.reconnect_probe", userId: userD, payload: { userId: userD, provider: "shopify" } });

  await check("reconnect + old worker: a job queued before a reconnect resolves the CURRENT (new) credential when it finally runs, not a captured stale one", async () => {
    saveConnection(userD, "shopify", { accessToken: `new-reconnected-token-${stamp}`, expiresAt: null, scopes: [], meta: {} });
    await processJobsTick();
    const after = getJob(jobQueuedBeforeReconnect.id);
    assert.equal(after.status, "completed", "the job succeeds — the connection genuinely is active, just with different credentials now");
    assert.equal(after.result.tokenLength, `new-reconnected-token-${stamp}`.length, "the job used the CURRENT token, confirming credentials are always resolved fresh at execution time, never captured at enqueue time");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} failure handling + concurrency checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Failure handling + concurrency regression suite crashed:", err);
  process.exit(1);
});
