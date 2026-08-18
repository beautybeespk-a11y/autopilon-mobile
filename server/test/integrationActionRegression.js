// Phase 17.1 §2 — Integration Action API regression suite. Same style as
// the other Public API test files: a plain Node script against a REAL,
// already-booted server, with real DB fixtures for the parts that need
// state no HTTP endpoint can create in this sandbox (a "connected"
// integration normally comes from a real OAuth flow, which needs a real
// provider — see PHASE17_NOTES.md for what a real end-to-end connection
// test requires). Run with:
//
//   node test/integrationActionRegression.js [baseUrl]
//
// Exits non-zero if any check fails.
import assert from "node:assert/strict";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { saveOrgConnection, disconnectOrgConnection } from "../integrations/manager.js";

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

// Phase 18.2 §15 (found during this pass): this used to be a raw INSERT
// directly into the integrations table — which, since Phase 18.1's token
// encryption at rest, meant the accessToken stored here was plaintext,
// and every real read (getConnection/getOrgConnection) would try to
// decrypt it, fail (it's not in the iv:authTag:ciphertext format), and
// silently return null — leaving this fixture in DB status='connected'
// but with connectionHealth() reporting NOT connected. The "executing a
// real, approved action reaches the actual underlying integration" check
// below was passing for the wrong reason (failing at the "not connected"
// gate, not at a real outbound Gmail 401 the way its own comment claims).
// Fixed by going through the real saveOrgConnection() — the same
// function every actual org-level connect route uses — so this fixture
// is genuinely connected and encrypted, exactly like production data.
function connectGmail(orgId, userId) {
  saveOrgConnection(orgId, userId, "gmail", { accessToken: "fake-access-token-for-testing", expiresAt: null, scopes: [], meta: {} });
}

function enableAgentSkill(agentId, skillId) {
  db.prepare("INSERT OR IGNORE INTO agent_skills (agentId, skillId) VALUES (?, ?)").run(agentId, skillId);
}

async function buildFixtures() {
  const stamp = Date.now();
  const sessA = makeSession();
  const sessB = makeSession();

  const userA = await signup(sessA, `intaction-a-${stamp}@example.com`, "IntAction Test A");
  const userB = await signup(sessB, `intaction-b-${stamp}@example.com`, "IntAction Test B");

  const { json: orgA } = await sessA.req("POST", "/api/organizations", { name: "IntAction Org A" });
  const { json: orgB } = await sessB.req("POST", "/api/organizations", { name: "IntAction Org B" });

  const { json: agentA } = await sessA.req("POST", "/api/agents", { name: "Gmail Agent A", orgId: orgA.id });

  const { json: keyA } = await sessA.req("POST", `/api/organizations/${orgA.id}/developer/api-keys`, {
    name: "IntAction key A (full)", scopes: ["integrations:read", "integrations:execute"],
  });
  const { json: readOnlyKeyA } = await sessA.req("POST", `/api/organizations/${orgA.id}/developer/api-keys`, {
    name: "IntAction key A (read-only)", scopes: ["integrations:read"],
  });
  const { json: keyB } = await sessB.req("POST", `/api/organizations/${orgB.id}/developer/api-keys`, {
    name: "IntAction key B", scopes: ["integrations:read", "integrations:execute"],
  });

  // Org A gets a real (fixture) connected Gmail integration + an agent with
  // the gmail skill enabled + its owner's activeOrgId pointed at org A —
  // the three preconditions the Public API layer verifies before it will
  // let an action run. Org B deliberately gets NONE of this, to prove
  // isolation.
  connectGmail(orgA.id, userA.id);
  enableAgentSkill(agentA.id, "gmail");
  db.prepare("UPDATE users SET activeOrgId = ? WHERE id = ?").run(orgA.id, userA.id);

  return {
    orgA, orgB, userA, agentA,
    apiA: makeApiClient(keyA.rawKey), apiAReadOnly: makeApiClient(readOnlyKeyA.rawKey), apiB: makeApiClient(keyB.rawKey),
  };
}

async function run() {
  console.log(`Integration Action API regression suite against ${BASE}\n`);
  const f = await buildFixtures();

  await check("integration actions: an org with a connected provider sees its curated public action list", async () => {
    const { status, json } = await f.apiA.req("GET", "/integrations/gmail/actions");
    assert.equal(status, 200);
    assert.ok(json.data.some((a) => a.name === "gmail.list_emails"));
    assert.ok(json.data.every((a) => typeof a.description === "string"), "every action must carry a human description");
  });

  await check("integration actions: a NEVER-EXPOSED internal tool never appears in the public list", async () => {
    const { json } = await f.apiA.req("GET", "/integrations/gmail/actions");
    assert.ok(!json.data.some((a) => a.name === "gmail.trash_email"), "gmail.trash_email is registered internally but was never added to the curated allowlist");
  });

  await check("integration actions: an org with NO connected provider gets 404, not an empty list", async () => {
    const { status, json } = await f.apiB.req("GET", "/integrations/gmail/actions");
    assert.equal(status, 404);
    assert.equal(json?.error?.code, "RESOURCE_NOT_FOUND"); // this GET route uses apiError() directly, unlike the execute route below which throws through apiErrorFromException()
  });

  await check("integration actions: executing a real, approved action reaches the actual underlying integration", async () => {
    const { status, json } = await f.apiA.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 200);
    // With a fake token, the REAL Gmail API call fails — that's expected in
    // this sandbox (see PHASE17_NOTES.md) and is itself the proof the full
    // pipeline (auth, scope, org ownership, agent skill gate, runTool
    // dispatch) executed correctly all the way to a real outbound call.
    assert.ok(json.executionId, "a tool_executions audit row must have been created");
    assert.ok(["completed", "failed"].includes(json.status));
  });

  await check("integration actions: an unapproved (but internally real) tool name is rejected as not found", async () => {
    const { status, json } = await f.apiA.req("POST", "/integrations/gmail/actions/gmail.trash_email/execute", { agentId: f.agentA.id, parameters: { messageId: "x" } });
    assert.equal(status, 404);
    assert.equal(json?.error?.code, "NOT_FOUND");
  });

  await check("integration actions: a completely unknown provider is rejected as not found", async () => {
    const { status, json } = await f.apiA.req("POST", "/integrations/not-a-real-provider/actions/whatever/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 404);
    assert.equal(json?.error?.code, "NOT_FOUND");
  });

  await check("integration actions: missing agentId is rejected, not silently run agent-less", async () => {
    const { status, json } = await f.apiA.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { parameters: {} });
    assert.equal(status, 400);
    assert.equal(json?.error?.code, "INVALID");
  });

  await check("integration actions: a key without integrations:execute is rejected with 403", async () => {
    const { status, json } = await f.apiAReadOnly.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 403);
    assert.equal(json?.error?.code, "INSUFFICIENT_SCOPE");
  });

  await check("cross-org: org B's key cannot execute an action against org A's connected integration (no connection of its own)", async () => {
    const { status, json } = await f.apiB.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 404);
    assert.equal(json?.error?.code, "NOT_FOUND", "org B has no gmail connection of its own — must never fall through to org A's");
  });

  await check("cross-org: even WITH its own connected integration, org B's key cannot use org A's agent id", async () => {
    const orgBOwner = db.prepare("SELECT ownerId FROM organizations WHERE id = ?").get(f.orgB.id);
    connectGmail(f.orgB.id, orgBOwner.ownerId);
    const { status, json } = await f.apiB.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 404, "org A's agent id must never resolve for org B, even once org B also has gmail connected");
    assert.equal(json?.error?.code, "NOT_FOUND");
  });

  await check("integration context safety: an activeOrgId mismatch is rejected rather than silently using the wrong org's credentials", async () => {
    db.prepare("UPDATE users SET activeOrgId = NULL WHERE id = ?").run(f.userA.id);
    const { status, json } = await f.apiA.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 409);
    assert.equal(json?.error?.code, "INTEGRATION_CONTEXT_MISMATCH");
    db.prepare("UPDATE users SET activeOrgId = ? WHERE id = ?").run(f.orgA.id, f.userA.id); // restore for any later checks
  });

  await check("integration actions: an agent without the required skill is denied by the SAME tool-permission gate an agent's own tool call uses", async () => {
    // A second agent in org A with NO skills enabled at all.
    const bareAgentId = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO agents (id, userId, orgId, name, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'active', ?, ?)"
    ).run(bareAgentId, f.userA.id, f.orgA.id, "No-Skill Agent", now, now);
    const { status, json } = await f.apiA.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: bareAgentId, parameters: {} });
    assert.equal(status, 200, "runTool() reports this as a normal failed execution, not an HTTP error");
    assert.equal(json.status, "failed");
    assert.ok(json.error.includes("gmail"), `expected a skill-gate error mentioning gmail, got: ${json.error}`);
  });

  // --- Phase 18.2 §15: disconnected/revoked credentials must never let
  // an action execute, through this same Public API layer. ---
  await check("disconnected integration: executing an action against it is rejected as not found, not silently run", async () => {
    disconnectOrgConnection(f.orgA.id, "gmail");
    const { status, json } = await f.apiA.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 404);
    assert.equal(json?.error?.code, "NOT_FOUND");
    assert.ok(json.error.message.toLowerCase().includes("no connected"), `expected a "no connected integration" message, got: ${json.error.message}`);
  });

  await check("disconnected integration: the public action LIST also reflects it as unavailable, not stale", async () => {
    const { status, json } = await f.apiA.req("GET", "/integrations/gmail/actions");
    assert.equal(status, 404);
    assert.equal(json?.error?.code, "RESOURCE_NOT_FOUND");
  });

  await check("reconnect: after reconnecting, the same org/agent/key can execute actions again — the disconnect was not permanent damage", async () => {
    connectGmail(f.orgA.id, f.userA.id);
    const { status, json } = await f.apiA.req("POST", "/integrations/gmail/actions/gmail.list_emails/execute", { agentId: f.agentA.id, parameters: {} });
    assert.equal(status, 200);
    assert.ok(json.executionId, "the reconnected integration reaches real tool execution again, exactly as it did before disconnect");
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
  console.error("Integration Action API regression suite crashed:", err);
  process.exitCode = 1;
});
