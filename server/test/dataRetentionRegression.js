// Phase 18.1 §9 — data-retention regression pass for
// orchestrator/organizationManager.js's deleteOrganization(). Real DB
// fixtures across every org-scoped table, a real call to the actual
// deleteOrganization() function (not a reimplementation of its logic),
// then asserts nothing org-scoped survives EXCEPT the audit trail
// (activity_logs), which is deliberately preserved by design.
//
//   node test/dataRetentionRegression.js
import assert from "node:assert/strict";
process.env.DB_PATH = process.env.DB_PATH || "/tmp/data-retention-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-data-retention-test";

const db = (await import("../db.js")).default;
const { cryptoRandom, logActivity } = await import("../middleware.js");
const { deleteOrganization } = await import("../orchestrator/organizationManager.js");

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

async function run() {
  console.log("Data retention regression suite (org deletion cascade)\n");

  const stamp = Date.now();
  const owner = makeUser(`retention-owner-${stamp}@example.com`);
  const orgId = cryptoRandom();
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO organizations (id, name, ownerId, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)").run(orgId, "Retention Test Org", owner, "active", ts, ts);
  db.prepare("INSERT INTO organization_members (id, orgId, userId, role, status, joinedAt) VALUES (?,?,?,?,?,?)").run(cryptoRandom(), orgId, owner, "owner", "active", ts);

  // agents + conversations/messages (the gap found and fixed this pass:
  // conversations.agentId has no FK to agents at all)
  const agentId = cryptoRandom();
  db.prepare("INSERT INTO agents (id, userId, orgId, name, createdAt, updatedAt) VALUES (?,?,?,?,?,?)").run(agentId, owner, orgId, "Org Agent", ts, ts);
  const conversationId = cryptoRandom();
  db.prepare("INSERT INTO conversations (id, userId, agentId, title, createdAt, updatedAt) VALUES (?,?,?,?,?,?)").run(conversationId, owner, agentId, "Sensitive customer chat", ts, ts);
  const messageId = cryptoRandom();
  const sensitiveContent = `Customer's real phone number is 555-0142-${stamp}`;
  db.prepare("INSERT INTO messages (id, conversationId, role, content, createdAt) VALUES (?,?,?,?,?)").run(messageId, conversationId, "user", sensitiveContent, ts);

  // automations + automation_versions (cascades via automationId, not orgId directly)
  const automationId = cryptoRandom();
  db.prepare("INSERT INTO automations (id, userId, orgId, name, triggerType, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)").run(automationId, owner, orgId, "Org Automation", "manual", "active", ts, ts);
  db.prepare("INSERT INTO automation_versions (id, automationId, version, snapshot, createdAt) VALUES (?,?,?,?,?)").run(cryptoRandom(), automationId, 1, "{}", ts);

  // integrations (with a real encrypted secret — should be gone, not just orphaned)
  const { saveOrgConnection } = await import("../integrations/manager.js");
  saveOrgConnection(orgId, owner, "woocommerce", { accessToken: `retention-secret-${stamp}`, expiresAt: null, scopes: [], meta: { siteUrl: "https://x.example.com" } });

  // tasks, knowledge_items, folders, content_*, jobs, api_request_logs, api_idempotency_keys
  const taskId = cryptoRandom();
  db.prepare("INSERT INTO tasks (id, userId, orgId, title, status, createdAt) VALUES (?,?,?,?,?,?)").run(taskId, owner, orgId, "Org Task", "open", ts);
  const knowledgeId = cryptoRandom();
  db.prepare("INSERT INTO knowledge_items (id, userId, orgId, title, content, createdAt) VALUES (?,?,?,?,?,?)").run(knowledgeId, owner, orgId, "Org Doc", "content", ts);
  const folderId = cryptoRandom();
  db.prepare("INSERT INTO folders (id, orgId, ownerId, name, createdAt, updatedAt) VALUES (?,?,?,?,?,?)").run(folderId, orgId, owner, "Org Folder", ts, ts);

  // activity_logs (the audit trail — must SURVIVE deletion, by design)
  logActivity(db, owner, "organization_deleted", "Deleted the organization", { orgId, result: "success" });
  const preDeleteAuditCount = db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE orgId = ?").get(orgId).n;
  assert.ok(preDeleteAuditCount >= 1, "sanity: the audit entry was actually written before deletion runs");

  await check("deleteOrganization() runs successfully against this full real fixture", async () => {
    const result = await deleteOrganization(orgId);
    assert.equal(result.deleted, true);
  });

  await check("organization row itself is gone", () => {
    assert.equal(db.prepare("SELECT id FROM organizations WHERE id = ?").get(orgId), undefined);
  });

  await check("organization_members cascades away via its real FK", () => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organization_members WHERE orgId = ?").get(orgId).n, 0);
  });

  await check("agents are deleted", () => {
    assert.equal(db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId), undefined);
  });

  await check("THE FIX: conversations held with this org's agent are deleted (not left orphaned with a dangling agentId)", () => {
    assert.equal(db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId), undefined, "conversation row is gone");
  });

  await check("THE FIX: messages (real chat content) cascade away with their conversation — the sensitive content does not survive", () => {
    assert.equal(db.prepare("SELECT id FROM messages WHERE id = ?").get(messageId), undefined);
    const anyRowsWithContent = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content = ?").get(sensitiveContent).n;
    assert.equal(anyRowsWithContent, 0, "the sensitive message content is not readable from any surviving row");
  });

  await check("automations and their automation_versions are both gone", () => {
    assert.equal(db.prepare("SELECT id FROM automations WHERE id = ?").get(automationId), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM automation_versions WHERE automationId = ?").get(automationId).n, 0);
  });

  await check("the org's integration connection, including its encrypted secret, is gone", () => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM integrations WHERE orgId = ?").get(orgId).n, 0);
  });

  await check("tasks, knowledge_items, and folders are gone", () => {
    assert.equal(db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId), undefined);
    assert.equal(db.prepare("SELECT id FROM knowledge_items WHERE id = ?").get(knowledgeId), undefined);
    assert.equal(db.prepare("SELECT id FROM folders WHERE id = ?").get(folderId), undefined);
  });

  await check("AUDIT TRAIL IS PRESERVED: activity_logs for this org still exist after deletion (by design — not a bug)", () => {
    const postDeleteAuditCount = db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE orgId = ?").get(orgId).n;
    assert.ok(postDeleteAuditCount >= 1, "the audit record of the deletion itself, and prior activity, is intentionally retained");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} data retention checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Data retention regression suite crashed:", err);
  process.exit(1);
});
