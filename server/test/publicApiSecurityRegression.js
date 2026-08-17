// Phase 17 Public API security regression suite — extends the Phase 16
// session-based suite (test/securityRegression.js) with checks specific to
// Bearer-API-key auth: revoked/expired/wrong-scope/wrong-org keys, SSRF
// protection on developer webhooks, webhook signature verification, quota/
// billing bypass via an API key, and feature-flag gating. Same style as the
// Phase 16 suite: a plain Node script against a REAL, already-booted
// server, no mocking. Run with:
//
//   node test/publicApiSecurityRegression.js [baseUrl]
//
// Exits non-zero if any check fails.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { signWebhookPayload, verifyWebhookSignature } from "../orchestrator/webhookSigning.js";
import { assertSafeWebhookUrl } from "../publicApi/ssrf.js";

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

// --- tiny session HTTP client (for signup/org/console setup) ----------------------
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
      try { json = await res.json(); } catch { /* non-JSON, fine for some checks */ }
      return { status: res.status, json };
    },
  };
}

// --- tiny Bearer-key HTTP client for /api/v1 ---------------------------------------
function makeApiClient(rawKey) {
  return {
    async req(method, path, body) {
      const res = await fetch(`${BASE}/api/v1${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(rawKey ? { Authorization: `Bearer ${rawKey}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json };
    },
  };
}

async function signup(session, email, name) {
  const { json } = await session.req("POST", "/api/auth/signup", { email, password: "TestPass123!", name });
  return json.user;
}

async function createOrg(session, name) {
  const { json } = await session.req("POST", "/api/organizations", { name });
  return json;
}

async function createDevKey(session, orgId, { name, scopes, expiresAt }) {
  const { json } = await session.req("POST", `/api/organizations/${orgId}/developer/api-keys`, { name, scopes, expiresAt });
  return json;
}

// --- fixtures ------------------------------------------------------------------------
async function buildFixtures() {
  const stamp = Date.now();
  const sessA = makeSession();
  const sessB = makeSession();
  const sessAdmin = makeSession();

  const userA = await signup(sessA, `papi-a-${stamp}@example.com`, "Public API Test A");
  const userB = await signup(sessB, `papi-b-${stamp}@example.com`, "Public API Test B");
  const userAdmin = await signup(sessAdmin, `papi-admin-${stamp}@example.com`, "Public API Test Admin");
  db.prepare("UPDATE users SET isPlatformAdmin = 1 WHERE id = ?").run(userAdmin.id);

  const orgA = await createOrg(sessA, "Public API Org A");
  const orgB = await createOrg(sessB, "Public API Org B");

  // A full-scope key for org A, used as the "legitimate" key for most checks.
  const keyA = await createDevKey(sessA, orgA.id, {
    name: "Full scope key A",
    scopes: ["agents:read", "agents:execute", "tasks:read", "tasks:write", "projects:read", "projects:write", "files:read", "webhooks:manage", "automations:read"],
  });
  // A narrow key for org A, used for the wrong-scope check.
  const narrowKeyA = await createDevKey(sessA, orgA.id, { name: "Narrow key A", scopes: ["tasks:read"] });
  // A key for org B, used for the cross-org checks.
  const keyB = await createDevKey(sessB, orgB.id, { name: "Full scope key B", scopes: ["agents:read", "tasks:read", "projects:read", "webhooks:manage"] });
  // A key created already-expired.
  const expiredKey = await createDevKey(sessA, orgA.id, {
    name: "Expired key", scopes: ["tasks:read"], expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  // A key that will be revoked right after creation.
  const toRevoke = await createDevKey(sessA, orgA.id, { name: "To be revoked", scopes: ["tasks:read"] });
  await sessA.req("POST", `/api/organizations/${orgA.id}/developer/api-keys/${toRevoke.id}/revoke`, {});

  // Real org-A resources via the Public API itself (dogfooding), to have
  // something for the cross-org / quota checks to target.
  const apiA = makeApiClient(keyA.rawKey);
  const { json: agentA } = await sessA.req("POST", "/api/agents", { name: "Public API Agent A", description: "owned by A", orgId: orgA.id });
  const { json: taskA } = await apiA.req("POST", "/tasks", { title: "Org A task" });
  const { json: wsA } = await sessA.req("POST", `/api/organizations/${orgA.id}/workspaces`, { name: "Org A workspace" });
  const { json: projectA } = await apiA.req("POST", "/projects", { workspaceId: wsA.id, name: "Org A project" });

  return { sessA, sessB, sessAdmin, userA, userB, orgA, orgB, keyA, narrowKeyA, keyB, expiredKey, toRevoke, agentA, taskA, projectA, apiA };
}

async function run() {
  console.log(`Public API security regression suite against ${BASE}\n`);
  const f = await buildFixtures();

  // --- Authentication edge cases --------------------------------------------------
  await check("auth: no Authorization header -> 401 UNAUTHENTICATED", async () => {
    const anon = makeApiClient(null);
    const { status, json } = await anon.req("GET", "/agents");
    assert.equal(status, 401);
    assert.equal(json?.error?.code, "UNAUTHENTICATED");
  });

  await check("auth: garbage Bearer token -> 401 UNAUTHENTICATED", async () => {
    const bogus = makeApiClient("ap_live_not_a_real_key_at_all");
    const { status, json } = await bogus.req("GET", "/agents");
    assert.equal(status, 401);
    assert.equal(json?.error?.code, "UNAUTHENTICATED");
  });

  await check("auth: revoked key -> 401 UNAUTHENTICATED", async () => {
    const revoked = makeApiClient(f.toRevoke.rawKey);
    const { status, json } = await revoked.req("GET", "/tasks");
    assert.equal(status, 401);
    assert.equal(json?.error?.code, "UNAUTHENTICATED");
  });

  await check("auth: expired key -> 401 UNAUTHENTICATED", async () => {
    const expired = makeApiClient(f.expiredKey.rawKey);
    const { status, json } = await expired.req("GET", "/tasks");
    assert.equal(status, 401);
    assert.equal(json?.error?.code, "UNAUTHENTICATED");
  });

  await check("auth: rotating a key invalidates the old secret immediately", async () => {
    const toRotate = await createDevKey(f.sessA, f.orgA.id, { name: "Rotate me", scopes: ["tasks:read"] });
    const oldClient = makeApiClient(toRotate.rawKey);
    const before = await oldClient.req("GET", "/tasks");
    assert.equal(before.status, 200, "key should work before rotation");
    await f.sessA.req("POST", `/api/organizations/${f.orgA.id}/developer/api-keys/${toRotate.id}/rotate`, {});
    const after = await oldClient.req("GET", "/tasks");
    assert.equal(after.status, 401, "old secret must stop working immediately after rotation");
  });

  // --- Authorization (scopes) -------------------------------------------------------
  await check("scope: a key without the required scope -> 403 INSUFFICIENT_SCOPE", async () => {
    const narrow = makeApiClient(f.narrowKeyA.rawKey);
    const { status, json } = await narrow.req("GET", "/agents"); // narrowKeyA only has tasks:read
    assert.equal(status, 403);
    assert.equal(json?.error?.code, "INSUFFICIENT_SCOPE");
  });

  await check("scope: the same key with the right scope succeeds", async () => {
    const narrow = makeApiClient(f.narrowKeyA.rawKey);
    const { status } = await narrow.req("GET", "/tasks");
    assert.equal(status, 200);
  });

  // --- Cross-tenant isolation via API key -------------------------------------------
  await check("cross-org: org B's key cannot read org A's agent by id (404, not 403)", async () => {
    const apiB = makeApiClient(f.keyB.rawKey);
    const { status, json } = await apiB.req("GET", `/agents/${f.agentA.id}`);
    assert.equal(status, 404, "cross-org agent access must 404, not confirm existence via 403");
    assert.equal(json?.error?.code, "RESOURCE_NOT_FOUND");
  });

  await check("cross-org: org B's key cannot read org A's task by id", async () => {
    const apiB = makeApiClient(f.keyB.rawKey);
    const { status } = await apiB.req("GET", `/tasks/${f.taskA.id}`);
    assert.equal(status, 404);
  });

  await check("cross-org: org B's key cannot read org A's project by id", async () => {
    const apiB = makeApiClient(f.keyB.rawKey);
    const { status } = await apiB.req("GET", `/projects/${f.projectA.id}`);
    assert.equal(status, 404);
  });

  await check("cross-org: org B's key cannot list org A's tasks (each org only ever sees its own)", async () => {
    const apiB = makeApiClient(f.keyB.rawKey);
    const { json } = await apiB.req("GET", "/tasks");
    assert.ok(Array.isArray(json?.data), "expected a data array");
    assert.ok(!json.data.some((t) => t.id === f.taskA.id), "org B's task list must never include org A's task");
  });

  // --- SSRF protection on developer webhooks ----------------------------------------
  const ssrfTargets = [
    "http://127.0.0.1/admin",
    "http://localhost:9999/",
    "http://169.254.169.254/latest/meta-data/", // cloud instance metadata
    "http://10.0.0.5/internal",
    "http://192.168.1.1/",
    "ftp://example.com/",
  ];
  for (const url of ssrfTargets) {
    await check(`SSRF: webhook creation rejects ${url}`, async () => {
      const { status, json } = await f.apiA.req("POST", "/webhooks", { url, events: ["task.created"] });
      assert.equal(status, 400, `expected 400 for ${url}, got ${status}`);
      assert.equal(json?.error?.code, "INVALID");
    });
  }

  await check("SSRF: a safe public HTTPS URL is accepted at the validator level", async () => {
    // Direct unit check of the validator (not a real outbound webhook
    // create/delivery, which the sandboxed test environment's own egress
    // proxy blocks for arbitrary domains — see Phase 17 completion report).
    await assertSafeWebhookUrl("https://example.com/webhooks/receiver");
  });

  // --- Webhook signature verification (function-level, no live receiver needed) ----
  await check("webhook signing: a valid signature verifies successfully", () => {
    const secret = "whsec_test_secret_value";
    const body = JSON.stringify({ id: "evt_1", type: "task.created", data: { taskId: "t1" } });
    const { header } = signWebhookPayload(secret, body);
    assert.equal(verifyWebhookSignature(secret, body, header), true);
  });

  await check("webhook signing: a tampered body fails verification", () => {
    const secret = "whsec_test_secret_value";
    const body = JSON.stringify({ id: "evt_1", type: "task.created", data: { taskId: "t1" } });
    const { header } = signWebhookPayload(secret, body);
    const tamperedBody = JSON.stringify({ id: "evt_1", type: "task.created", data: { taskId: "t2 — attacker-modified" } });
    assert.equal(verifyWebhookSignature(secret, tamperedBody, header), false);
  });

  await check("webhook signing: the wrong secret fails verification", () => {
    const body = JSON.stringify({ id: "evt_1", type: "task.created", data: {} });
    const { header } = signWebhookPayload("whsec_correct_secret", body);
    assert.equal(verifyWebhookSignature("whsec_wrong_secret", body, header), false);
  });

  await check("webhook signing: a stale (replayed) timestamp fails verification", () => {
    const secret = "whsec_test_secret_value";
    const body = JSON.stringify({ id: "evt_1", type: "task.created", data: {} });
    // Hand-construct a signature as if it were signed 10 minutes ago — same
    // HMAC math as signWebhookPayload(), but with an old timestamp, to prove
    // an attacker replaying a captured (timestamp, signature, body) triple
    // outside the tolerance window is rejected.
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
    const signature = crypto.createHmac("sha256", secret).update(`${staleTimestamp}.${body}`).digest("hex");
    const header = `t=${staleTimestamp},v1=${signature}`;
    assert.equal(verifyWebhookSignature(secret, body, header, { toleranceSeconds: 300 }), false);
  });

  await check("webhook signing: a malformed header fails verification, never throws", () => {
    assert.equal(verifyWebhookSignature("whsec_x", "{}", "not-a-valid-header"), false);
    assert.equal(verifyWebhookSignature("whsec_x", "{}", ""), false);
    assert.equal(verifyWebhookSignature("whsec_x", "{}", null), false);
  });

  // --- Quota / billing bypass via API key (regression on Task 38's fix, API-key path) --
  await check("quota bypass: agent execution via API key is blocked once org A hits its spend limit", async () => {
    await f.sessA.req("PATCH", `/api/organizations/${f.orgA.id}/spend-limits`, { dailyLimitCents: 50 });
    db.prepare("INSERT INTO usage_records (id, orgId, type, quantity, costCents, metadata, createdAt) VALUES (?,?,?,?,?,?,?)")
      .run(cryptoRandom(), f.orgA.id, "prompt_tokens", 100, 50, "{}", new Date().toISOString());
    const { status, json } = await f.apiA.req("POST", `/agents/${f.agentA.id}/execute`, { message: "should be blocked" });
    assert.equal(status, 429, `expected 429 QUOTA_EXCEEDED, got ${status} (${JSON.stringify(json)})`);
    assert.equal(json?.error?.code, "QUOTA_EXCEEDED");
    // cleanup so it doesn't affect anything run after this suite
    await f.sessA.req("PATCH", `/api/organizations/${f.orgA.id}/spend-limits`, { dailyLimitCents: null });
  });

  await check("quota bypass: org A hitting its spend limit does not block org B's key", async () => {
    // org A's limit is still in place from the previous check's setup at
    // this point in the run (cleared at the end of that check) — verify
    // isolation using a fresh, still-active limit instead of relying on
    // check ordering.
    await f.sessA.req("PATCH", `/api/organizations/${f.orgA.id}/spend-limits`, { dailyLimitCents: 1 });
    db.prepare("INSERT INTO usage_records (id, orgId, type, quantity, costCents, metadata, createdAt) VALUES (?,?,?,?,?,?,?)")
      .run(cryptoRandom(), f.orgA.id, "prompt_tokens", 100, 999, "{}", new Date().toISOString());
    const apiB = makeApiClient(f.keyB.rawKey);
    const { status, json } = await apiB.req("GET", "/tasks"); // a plain read, not billed, but must not be affected by org A's state at all
    assert.equal(status, 200, `org B's key must be unaffected by org A's spend limit, got ${status}: ${JSON.stringify(json)}`);
    await f.sessA.req("PATCH", `/api/organizations/${f.orgA.id}/spend-limits`, { dailyLimitCents: null });
  });

  // --- Feature-flag gating (Task 53 regression) -------------------------------------
  await check("feature flags: disabling a resource flag blocks only that resource", async () => {
    await f.sessAdmin.req("PATCH", "/api/admin/feature-flags/public_api_tasks", { enabled: false });
    const blocked = await f.apiA.req("GET", "/tasks");
    assert.equal(blocked.status, 503);
    assert.equal(blocked.json?.error?.code, "FEATURE_DISABLED");
    const unaffected = await f.apiA.req("GET", "/agents");
    assert.equal(unaffected.status, 200, "a sibling resource area must be unaffected by another resource's flag");
    await f.sessAdmin.req("PATCH", "/api/admin/feature-flags/public_api_tasks", { enabled: true }); // restore
  });

  await check("feature flags: disabling the master flag blocks the whole Public API", async () => {
    await f.sessAdmin.req("PATCH", "/api/admin/feature-flags/public_api", { enabled: false });
    const { status, json } = await f.apiA.req("GET", "/agents");
    assert.equal(status, 503);
    assert.equal(json?.error?.code, "FEATURE_DISABLED");
    await f.sessAdmin.req("PATCH", "/api/admin/feature-flags/public_api", { enabled: true }); // restore
  });

  await check("feature flags: a per-org override re-enables a capability the global default has off", async () => {
    await f.sessAdmin.req("PATCH", "/api/admin/feature-flags/public_api", { enabled: false });
    const stillBlocked = await f.apiA.req("GET", "/agents");
    assert.equal(stillBlocked.status, 503);
    await f.sessAdmin.req("POST", "/api/admin/feature-flags/public_api/overrides", { scopeType: "org", scopeId: f.orgA.id, enabled: true });
    const nowAllowed = await f.apiA.req("GET", "/agents");
    assert.equal(nowAllowed.status, 200, "org A override should re-enable it even while the global default is off");
    const apiB = makeApiClient(f.keyB.rawKey);
    const stillBlockedForB = await apiB.req("GET", "/agents");
    assert.equal(stillBlockedForB.status, 503, "the override is scoped to org A only — org B must remain blocked");
    // restore clean global state
    await f.sessAdmin.req("DELETE", `/api/admin/feature-flags/public_api/overrides/org/${f.orgA.id}`);
    await f.sessAdmin.req("PATCH", "/api/admin/feature-flags/public_api", { enabled: true });
  });

  // --- Secrets exposure --------------------------------------------------------------
  await check("secrets: creating an API key returns rawKey once; listing keys never returns it again", async () => {
    const created = await createDevKey(f.sessA, f.orgA.id, { name: "One-time secret check", scopes: ["tasks:read"] });
    assert.ok(created.rawKey?.startsWith("ap_live_"), "rawKey must be present on create");
    const { json: list } = await f.sessA.req("GET", `/api/organizations/${f.orgA.id}/developer/api-keys`);
    const raw = JSON.stringify(list);
    assert.ok(!raw.includes(created.rawKey), "the raw key must never appear again after creation");
  });

  await check("secrets: a webhook signing secret is never exposed to a different org's key", async () => {
    const { json: webhook } = await f.apiA.req("POST", "/webhooks", { url: "https://example.com/hooks/isolation-test", events: ["task.created"] });
    const apiB = makeApiClient(f.keyB.rawKey);
    const { status } = await apiB.req("GET", `/webhooks/${webhook.id}/secret`);
    assert.equal(status, 404, "org B's key must not be able to fetch org A's webhook secret");
  });

  // --- Summary -------------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f2 of failed) console.log(`  - ${f2.name}: ${f2.error}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("Public API security regression suite crashed:", err);
  process.exitCode = 1;
});
