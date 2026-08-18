// Phase 18.2 §5/§6 — queued job credential safety + cache invalidation
// regression. Real Job Manager, real queue provider (syncProvider(),
// SQLite-backed), real integrations/manager.js. Registers one small real
// job handler (mirroring how every real handler in jobs/handlers.js is
// structured: a thin wrapper that calls straight into real business
// logic) that calls the actual requireValidToken() a real integration
// tool would call — this is the literal mechanism every queued job in
// this app already uses to resolve credentials, not a simulation of it.
//
//   node test/queuedJobCredentialSafetyRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/queued-job-credential-safety-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-queued-job-test";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { saveConnection, disconnectIntegration, getConnection, requireValidToken } = await import("../integrations/manager.js");
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

// A real job handler, structured exactly like jobs/handlers.js's real
// ones — resolves the credential at RUN TIME via the real manager.js
// function every actual integration tool call also goes through, never
// from a value captured at enqueue time.
registerJobHandler("test.integration_probe", async (payload) => {
  const token = requireValidToken(payload.userId, payload.provider);
  return { tokenLength: token.length, usedProvider: payload.provider }; // never echo the token itself into the job result
});

const stamp = Date.now();

async function run() {
  console.log("Queued job credential safety regression suite\n");

  const userA = makeUser(`queuejob-a-${stamp}@example.com`);
  const realToken = `real-gmail-token-${stamp}`;
  saveConnection(userA, "gmail", { accessToken: realToken, expiresAt: null, scopes: [], meta: {} });

  await check("baseline: a job queued and processed while still connected succeeds and resolves the current real token", async () => {
    const job = createJob({ type: "test.integration_probe", userId: userA, payload: { userId: userA, provider: "gmail" } });
    await processJobsTick();
    const after = getJob(job.id);
    assert.equal(after.status, "completed");
    assert.equal(after.result.tokenLength, realToken.length);
  });

  // --- The literal Phase 18.2 §5 scenario: connect -> queue -> disconnect
  // -> worker attempts the job -> must not use the (now revoked) credential ---
  const userB = makeUser(`queuejob-b-${stamp}@example.com`);
  saveConnection(userB, "gmail", { accessToken: `real-gmail-token-b-${stamp}`, expiresAt: null, scopes: [], meta: {} });
  const queuedBeforeDisconnect = createJob({ type: "test.integration_probe", userId: userB, payload: { userId: userB, provider: "gmail" } });
  disconnectIntegration(userB, "gmail"); // disconnect happens AFTER the job was already queued

  await check("a job queued before disconnect, but processed after, fails safely (immediately, not retried) instead of using the stale credential", async () => {
    await processJobsTick();
    const after = getJob(queuedBeforeDisconnect.id);
    // requireValidToken()'s INTEGRATION_NOT_CONNECTED is marked
    // retryable=false (Phase 18.2 §5 fix, found via this exact test) —
    // retrying could never make a disconnected integration reconnect
    // itself, so this must land on 'failed' immediately, not cycle
    // through queued/backoff/dead_letter first.
    assert.equal(after.status, "failed", "the job fails immediately — it does not silently succeed using a credential that no longer exists, and is not pointlessly retried");
    assert.ok(after.error.includes("not connected"), "the failure reason is the standard, clean INTEGRATION_NOT_CONNECTED message");
    assert.ok(!after.error.includes(`real-gmail-token-b-${stamp}`), "the job's stored error never contains the old token value");
    assert.equal(after.result, null, "no result payload was produced — the job never reached the point of using a credential");
  });

  await check("after the failed job, the connection is confirmed fully disconnected (not left in a half-revoked state)", () => {
    const conn = getConnection(userB, "gmail");
    assert.equal(conn.accessToken, null);
    assert.equal(conn.status, "not_connected");
  });

  // --- Cache invalidation (§6): confirmed by construction, verified here
  // directly — getConnection() has no caching layer in front of it at
  // all (no cached()/cachedAsync() call anywhere in integrations/), so
  // "stale cached credential" cannot happen: every read is a fresh DB
  // read. This test proves that property directly rather than asserting
  // it from reading the source. ---
  const userC = makeUser(`queuejob-c-${stamp}@example.com`);
  saveConnection(userC, "gmail", { accessToken: `real-gmail-token-c-${stamp}`, expiresAt: null, scopes: [], meta: {} });
  await check("no stale read: querying the connection immediately after disconnect never returns the old token, even from a rapid back-to-back read", () => {
    const before = getConnection(userC, "gmail");
    assert.equal(before.accessToken, `real-gmail-token-c-${stamp}`);
    disconnectIntegration(userC, "gmail");
    const after = getConnection(userC, "gmail");
    assert.equal(after.accessToken, null, "the very next read reflects the disconnect immediately — no cache layer could be serving a stale value");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} queued job credential safety checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Queued job credential safety regression suite crashed:", err);
  process.exit(1);
});
