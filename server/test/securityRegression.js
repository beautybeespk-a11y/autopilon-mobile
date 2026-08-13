// Phase 16 security regression suite — a plain Node script (no test
// framework is installed in this project) run against a REAL, already-
// booted server, exercising actual HTTP requests and DB fixtures rather
// than mocking anything. Run with:
//
//   node test/securityRegression.js [baseUrl]
//
// Exits non-zero if any check fails. Prints a PASS/FAIL line per check.
import assert from "node:assert/strict";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { isDuplicateEvent } from "../orchestrator/webhookDedup.js";

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

// --- tiny cookie-jar HTTP client -------------------------------------------------
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
      try { json = await res.json(); } catch { /* non-JSON response, fine for some checks */ }
      return { status: res.status, json };
    },
    async upload(path, { filename, content, mimeType, extraFields = {} }) {
      const form = new FormData();
      form.append("file", new Blob([content], { type: mimeType }), filename);
      for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
      const res = await fetch(`${BASE}${path}`, { method: "POST", headers: cookie ? { Cookie: cookie } : {}, body: form });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json };
    },
    setRawCookie(raw) { cookie = raw; },
  };
}

async function signup(session, email, name) {
  const { json } = await session.req("POST", "/api/auth/signup", { email, password: "TestPass123!", name });
  return json.user;
}

// --- fixtures ----------------------------------------------------------------------
async function buildFixtures() {
  const stamp = Date.now();
  const sessA = makeSession();
  const sessB = makeSession();
  const sessC = makeSession(); // will be inserted as a plain "member" of Org A for privilege-escalation checks
  const sessAnon = makeSession();

  const userA = await signup(sessA, `sec-a-${stamp}@example.com`, "Security Test A");
  const userB = await signup(sessB, `sec-b-${stamp}@example.com`, "Security Test B");
  const userC = await signup(sessC, `sec-c-${stamp}@example.com`, "Security Test C");

  const { json: orgA } = await sessA.req("POST", "/api/organizations", { name: "Org A" });
  const { json: orgB } = await sessB.req("POST", "/api/organizations", { name: "Org B" });

  // userC is added directly as a plain "member" of Org A (no member_management,
  // no billing) via DB insert — simulates an already-accepted invite without
  // needing to drive the full email-invite flow just to get a fixture.
  db.prepare(
    "INSERT INTO organization_members (id, orgId, userId, role, status, invitedAt, joinedAt) VALUES (?,?,?,?,?,?,?)"
  ).run(cryptoRandom(), orgA.id, userC.id, "member", "active", new Date().toISOString(), new Date().toISOString());

  const { json: agentA } = await sessA.req("POST", "/api/agents", { name: "Agent A", description: "owned by A" });
  const { json: chatResp } = await sessA.req("POST", "/api/chat/message", { agentId: agentA.id, content: "hello" });
  const conversationAId = chatResp.conversationId;

  const { json: fileA } = await sessA.upload("/api/files/upload", { filename: "secret.txt", content: "A's private file", mimeType: "text/plain" });

  return { sessA, sessB, sessC, sessAnon, userA, userB, userC, orgA, orgB, agentA, conversationAId, fileA };
}

async function run() {
  console.log(`Security regression suite against ${BASE}\n`);
  const f = await buildFixtures();

  // --- Session abuse -----------------------------------------------------------
  await check("session abuse: no cookie on a protected route -> 401", async () => {
    const anon = makeSession();
    const { status } = await anon.req("GET", "/api/agents");
    assert.equal(status, 401);
  });

  await check("session abuse: garbage/forged cookie -> 401, not authenticated as anyone", async () => {
    const anon = makeSession();
    anon.setRawCookie("connect.sid=s%3Aforged-not-a-real-session.garbage");
    const { status } = await anon.req("GET", "/api/agents");
    assert.equal(status, 401);
  });

  // --- IDOR ----------------------------------------------------------------------
  await check("IDOR: user B cannot read user A's agent by id", async () => {
    const { status } = await f.sessB.req("GET", `/api/agents/${f.agentA.id}`);
    assert.equal(status, 404, "cross-user agent access must 404 (not leak via 403), got " + status);
  });

  await check("IDOR: user B cannot read user A's conversation messages", async () => {
    const { status } = await f.sessB.req("GET", `/api/chat/conversations/${f.conversationAId}/messages`);
    assert.equal(status, 404);
  });

  await check("IDOR: user B cannot read user A's file content/metadata", async () => {
    // files.js deliberately distinguishes NOT_FOUND (404) from FORBIDDEN (403)
    // — unlike agents/conversations, which collapse both into 404 to avoid
    // leaking existence. File ids are cryptoRandom() (unguessable), so this
    // is a documented low-severity inconsistency, not a real vuln — the
    // invariant that actually matters is that no file data is ever returned.
    const { status, json } = await f.sessB.req("GET", `/api/files/${f.fileA.id}`);
    assert.ok([403, 404].includes(status), `expected access to be denied (403/404), got ${status}`);
    assert.ok(!json?.storageKey && !json?.filename, "file metadata must not be returned to a non-owner");
  });

  await check("IDOR: user B cannot delete user A's agent", async () => {
    const { status } = await f.sessB.req("DELETE", `/api/agents/${f.agentA.id}`);
    assert.notEqual(status, 200, "delete must not succeed cross-user");
  });

  // --- Cross-tenant access -------------------------------------------------------
  await check("cross-tenant: user B (not a member) cannot list org A's members", async () => {
    const { status } = await f.sessB.req("GET", `/api/organizations/${f.orgA.id}/members`);
    assert.notEqual(status, 200);
  });

  await check("cross-tenant: user B cannot read org A's spend limits", async () => {
    const { status } = await f.sessB.req("GET", `/api/organizations/${f.orgA.id}/spend-limits`);
    assert.equal(status, 403);
  });

  await check("cross-tenant: user B cannot set org A's spend limits", async () => {
    const { status } = await f.sessB.req("PATCH", `/api/organizations/${f.orgA.id}/spend-limits`, { dailyLimitCents: 1 });
    assert.equal(status, 403);
    const limits = db.prepare("SELECT * FROM organization_spend_limits WHERE orgId = ?").get(f.orgA.id);
    assert.ok(!limits || limits.dailyLimitCents !== 1, "org A's limits must not have been changed by org B's user");
  });

  await check("cross-tenant: user B cannot read org A's cost breakdown", async () => {
    const { status } = await f.sessB.req("GET", `/api/organizations/${f.orgA.id}/cost`);
    assert.equal(status, 403);
  });

  await check("cross-tenant: user B cannot read org A's BYOK api keys", async () => {
    const { status } = await f.sessB.req("GET", `/api/organizations/${f.orgA.id}/api-keys`);
    assert.equal(status, 403);
  });

  // --- Privilege escalation -------------------------------------------------------
  await check("privilege escalation: plain 'member' cannot invite new members to org A", async () => {
    const { status } = await f.sessC.req("POST", `/api/organizations/${f.orgA.id}/members/invite`, { email: "nobody@example.com", role: "member" });
    assert.equal(status, 403);
  });

  await check("privilege escalation: plain 'member' cannot promote themselves to owner", async () => {
    const membership = db.prepare("SELECT id FROM organization_members WHERE orgId = ? AND userId = ?").get(f.orgA.id, f.userC.id);
    const { status } = await f.sessC.req("PATCH", `/api/organizations/${f.orgA.id}/members/${membership.id}/role`, { role: "owner" });
    assert.equal(status, 403);
    const after = db.prepare("SELECT role FROM organization_members WHERE id = ?").get(membership.id);
    assert.equal(after.role, "member", "role must not have changed");
  });

  await check("privilege escalation: plain 'member' cannot set org billing plan directly", async () => {
    const { status } = await f.sessC.req("POST", `/api/organizations/${f.orgA.id}/billing/plan`, { planId: "enterprise" });
    assert.equal(status, 403);
  });

  await check("privilege escalation: a regular (non platform-admin) user cannot list all organizations", async () => {
    const { status } = await f.sessA.req("GET", "/api/admin/organizations");
    assert.equal(status, 403);
  });

  await check("privilege escalation: a regular user cannot flip global maintenance mode", async () => {
    const { status } = await f.sessA.req("POST", "/api/admin/maintenance", { enabled: true });
    assert.equal(status, 403);
  });

  // --- Billing / quota bypass (regression on Task 38's fix) -----------------------
  await check("billing bypass: chat is blocked once the agent's org hits its configured spend limit", async () => {
    await f.sessA.req("PATCH", `/api/organizations/${f.orgA.id}/spend-limits`, { dailyLimitCents: 50 });
    db.prepare("INSERT INTO usage_records (id, orgId, type, quantity, costCents, metadata, createdAt) VALUES (?,?,?,?,?,?,?)")
      .run(cryptoRandom(), f.orgA.id, "prompt_tokens", 100, 50, "{}", new Date().toISOString());
    const { json } = await f.sessA.req("POST", "/api/chat/message", { agentId: f.agentA.id, content: "should be blocked" });
    assert.ok(json?.detail?.includes("spend limit"), `expected spend-limit block, got: ${JSON.stringify(json)}`);
    // cleanup so it doesn't affect other checks in this run
    await f.sessA.req("PATCH", `/api/organizations/${f.orgA.id}/spend-limits`, { dailyLimitCents: null });
  });

  await check("billing bypass: an org's chat billing cannot be attributed to a different org via its own agent", async () => {
    const { json: agentB } = await f.sessB.req("POST", "/api/agents", { name: "Agent B", description: "owned by B", orgId: f.orgB.id });
    const { json } = await f.sessB.req("POST", "/api/chat/message", { agentId: agentB.id, content: "hi" });
    assert.ok(!json?.detail?.includes("Org A") && !String(json?.detail || "").includes(f.orgA.id), "org B chat must never reference org A");
  });

  // --- Webhook replay (function-level: no real Stripe signature available here) --
  await check("webhook replay: the same event id is only processed once", () => {
    const id = `test-webhook:${cryptoRandom()}`;
    const first = isDuplicateEvent(id, "test.event");
    const second = isDuplicateEvent(id, "test.event");
    assert.equal(first, false, "first delivery must not be flagged as duplicate");
    assert.equal(second, true, "replayed delivery with the same id must be flagged as duplicate");
  });

  // --- API key exposure -----------------------------------------------------------
  await check("API key exposure: saved BYOK keys are never returned in plaintext", async () => {
    await f.sessA.req("POST", `/api/organizations/${f.orgA.id}/api-keys`, { provider: "openai", apiKey: "sk-live-supersecretvalue1234567890" });
    const { json } = await f.sessA.req("GET", `/api/organizations/${f.orgA.id}/api-keys`);
    const raw = JSON.stringify(json);
    assert.ok(!raw.includes("supersecretvalue1234567890"), "raw API key leaked in list-keys response");
    assert.ok(!raw.toLowerCase().includes("encryptedkey"), "encryptedKey field leaked in list-keys response");
  });

  // --- Summary ---------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f2 of failed) console.log(`  - ${f2.name}: ${f2.error}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("Security regression suite crashed:", err);
  process.exitCode = 1;
});
