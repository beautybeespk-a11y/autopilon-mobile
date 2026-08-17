// Phase 17.1 §1 — Idempotency-Key regression suite. Same style as the other
// two Public API test files: a plain Node script against a REAL,
// already-booted server, no mocking. Run with:
//
//   node test/idempotencyRegression.js [baseUrl]
//
// Exits non-zero if any check fails.
import assert from "node:assert/strict";
import db from "../db.js";

const BASE = process.argv[2] || process.env.SECURITY_TEST_BASE_URL || "http://localhost:4102";

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

function makeSession() {
  let cookie = null;
  return {
    async req(method, path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json };
    },
  };
}

function makeApiClient(rawKey) {
  return {
    async req(method, path, body, extraHeaders = {}) {
      const res = await fetch(`${BASE}/api/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(rawKey ? { Authorization: `Bearer ${rawKey}` } : {}), ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json, headers: res.headers };
    },
  };
}

async function signup(session, email, name) {
  const { json } = await session.req("POST", "/api/auth/signup", { email, password: "TestPass123!", name });
  return json.user;
}

async function buildFixtures() {
  const stamp = Date.now();
  const sessA = makeSession();
  const sessB = makeSession();

  await signup(sessA, `idem-a-${stamp}@example.com`, "Idempotency Test A");
  await signup(sessB, `idem-b-${stamp}@example.com`, "Idempotency Test B");

  const { json: orgA } = await sessA.req("POST", "/api/organizations", { name: "Idempotency Org A" });
  const { json: orgB } = await sessB.req("POST", "/api/organizations", { name: "Idempotency Org B" });

  const { json: keyA } = await sessA.req("POST", `/api/organizations/${orgA.id}/developer/api-keys`, {
    name: "Idempotency key A", scopes: ["tasks:read", "tasks:write", "projects:read", "projects:write"],
  });
  const { json: keyB } = await sessB.req("POST", `/api/organizations/${orgB.id}/developer/api-keys`, {
    name: "Idempotency key B", scopes: ["tasks:read", "tasks:write"],
  });
  const { json: wsA } = await sessA.req("POST", `/api/organizations/${orgA.id}/workspaces`, { name: "Idempotency WS A" });

  return { orgA, orgB, apiA: makeApiClient(keyA.rawKey), apiB: makeApiClient(keyB.rawKey), wsA };
}

async function run() {
  console.log(`Idempotency-Key regression suite against ${BASE}\n`);
  const f = await buildFixtures();

  let firstTaskId;
  await check("idempotency: first request with a key succeeds and creates a resource", async () => {
    const { status, json } = await f.apiA.req("POST", "/tasks", { title: "First idempotent task" }, { "Idempotency-Key": "suite-key-1" });
    assert.equal(status, 201);
    assert.ok(json.id);
    firstTaskId = json.id;
  });

  await check("idempotency: an identical retry with the same key replays the original result, no new resource", async () => {
    const { status, json, headers } = await f.apiA.req("POST", "/tasks", { title: "First idempotent task" }, { "Idempotency-Key": "suite-key-1" });
    assert.equal(status, 201);
    assert.equal(json.id, firstTaskId, "replayed response must return the SAME resource id, not a new one");
    assert.equal(headers.get("idempotency-replayed"), "true");
  });

  await check("idempotency: the same key reused with a DIFFERENT body is a 409 conflict, no new resource", async () => {
    const { status, json } = await f.apiA.req("POST", "/tasks", { title: "A completely different task" }, { "Idempotency-Key": "suite-key-1" });
    assert.equal(status, 409);
    assert.equal(json?.error?.code, "IDEMPOTENCY_KEY_CONFLICT");
  });

  await check("idempotency: exactly one task exists after all of the above (no accidental duplicate)", async () => {
    const { json } = await f.apiA.req("GET", "/tasks?limit=100");
    const matching = json.data.filter((t) => t.title === "First idempotent task");
    assert.equal(matching.length, 1, `expected exactly 1 task, found ${matching.length}`);
  });

  await check("idempotency: without the header, two identical requests create two separate resources (opt-in only)", async () => {
    const first = await f.apiA.req("POST", "/tasks", { title: "No idempotency key task" });
    const second = await f.apiA.req("POST", "/tasks", { title: "No idempotency key task" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.json.id, second.json.id, "without an Idempotency-Key, requests must NOT be deduped");
  });

  await check("idempotency: cross-key isolation — the same key VALUE on a different API key is entirely independent", async () => {
    const { status, json } = await f.apiB.req("POST", "/tasks", { title: "Org B's own task" }, { "Idempotency-Key": "suite-key-1" });
    assert.equal(status, 201, "org B's key must not be affected by org A's use of the identical Idempotency-Key string");
    assert.notEqual(json.id, firstTaskId);
  });

  await check("idempotency: concurrent duplicate requests never create more than one resource", async () => {
    const fire = () => f.apiA.req("POST", "/tasks", { title: "Concurrent idempotent task" }, { "Idempotency-Key": "suite-key-concurrent" });
    const [a, b] = await Promise.all([fire(), fire()]);
    // Whichever request loses the race either gets a 409 IN_PROGRESS, or (if
    // the winner has already fully completed by the time it runs) the
    // replayed 201 with the identical id — both are correct outcomes. The
    // one invariant that must always hold is checked below directly against
    // the database: never more than one row.
    for (const r of [a, b]) assert.ok([201, 409].includes(r.status), `unexpected status ${r.status}`);
    const created = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE title = ?").get("Concurrent idempotent task").c;
    assert.equal(created, 1, `expected exactly 1 row created concurrently, found ${created}`);
  });

  await check("idempotency: an expired reservation is treated as fresh, not blocked forever", async () => {
    const { json: created } = await f.apiA.req("POST", "/tasks", { title: "Expiring idempotency task" }, { "Idempotency-Key": "suite-key-expiring" });
    assert.equal(created.title, "Expiring idempotency task");
    // Force the stored reservation into the past directly, rather than
    // waiting out the real 24h TTL — same DB-fixture-manipulation approach
    // the other suites use for time-based state.
    db.prepare("UPDATE api_idempotency_keys SET expiresAt = ? WHERE idempotencyKey = 'suite-key-expiring'").run(new Date(Date.now() - 1000).toISOString());
    const { status, json: second } = await f.apiA.req("POST", "/tasks", { title: "A brand new different task" }, { "Idempotency-Key": "suite-key-expiring" });
    assert.equal(status, 201, "an expired key must allow a fresh request through, even with a different body");
    assert.notEqual(second.id, created.id);
  });

  await check("idempotency: also works on a second endpoint (projects), not just tasks", async () => {
    const first = await f.apiA.req("POST", "/projects", { workspaceId: f.wsA.id, name: "Idempotent project" }, { "Idempotency-Key": "suite-key-project-1" });
    assert.equal(first.status, 201);
    const second = await f.apiA.req("POST", "/projects", { workspaceId: f.wsA.id, name: "Idempotent project" }, { "Idempotency-Key": "suite-key-project-1" });
    assert.equal(second.json.id, first.json.id);
  });

  await check("idempotency: a header longer than 255 characters is rejected with 400, not silently truncated", async () => {
    const { status, json } = await f.apiA.req("POST", "/tasks", { title: "Oversized key task" }, { "Idempotency-Key": "x".repeat(300) });
    assert.equal(status, 400);
    assert.equal(json?.error?.code, "INVALID_REQUEST");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f2 of failed) console.log(`  - ${f2.name}: ${f2.error}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("Idempotency-Key regression suite crashed:", err);
  process.exitCode = 1;
});
