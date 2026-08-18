// Phase 18.2 §8/§9 — reconnect lifecycle + cross-user/cross-organization
// isolation regression. Real integrations/manager.js, real DB, real
// encryption. Exercises the full CONNECT -> USE -> DISCONNECT -> RECONNECT
// -> USE cycle and confirms every isolation boundary holds through it —
// with particular attention to the Phase 18.1 schema fix that lets a
// personal connection and an org-shared connection for the SAME provider
// coexist (previously blocked by a too-broad unique index).
//
//   node test/reconnectAndIsolationRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/reconnect-isolation-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-reconnect-test";

const db = (await import("../db.js")).default;
const { cryptoRandom, logActivity } = await import("../middleware.js");
const {
  saveConnection, getConnection, disconnectIntegration, requireValidToken, connectionHealth,
  saveOrgConnection, getOrgConnection, disconnectOrgConnection,
} = await import("../integrations/manager.js");

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
function makeOrg(name, ownerId) {
  const id = cryptoRandom();
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO organizations (id, name, ownerId, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)").run(id, name, ownerId, "active", ts, ts);
  return id;
}
function rowCount(sql, ...params) {
  return db.prepare(sql).get(...params).n;
}

const stamp = Date.now();

async function run() {
  console.log("Reconnect + cross-user/cross-org isolation regression suite\n");

  // --- Full personal reconnect cycle -----------------------------------
  const userA = makeUser(`reconnect-a-${stamp}@example.com`);
  const tokenV1 = `token-v1-${stamp}`;
  const tokenV2 = `token-v2-${stamp}`;

  saveConnection(userA, "shopify", { accessToken: tokenV1, expiresAt: null, scopes: [], meta: { shopDomain: "v1.myshopify.com" } });
  logActivity(db, userA, "integration_connected", "Connected Shopify");

  await check("CONNECT -> USE: the real token is immediately usable", () => {
    assert.equal(requireValidToken(userA, "shopify"), tokenV1);
    assert.equal(connectionHealth(userA, "shopify").connected, true);
  });

  disconnectIntegration(userA, "shopify");
  logActivity(db, userA, "integration_disconnected", "Disconnected Shopify");

  await check("DISCONNECT: the old token is no longer usable, and requireValidToken() fails cleanly", () => {
    assert.equal(connectionHealth(userA, "shopify").connected, false);
    assert.throws(() => requireValidToken(userA, "shopify"), /not connected/);
  });

  saveConnection(userA, "shopify", { accessToken: tokenV2, expiresAt: null, scopes: [], meta: { shopDomain: "v2.myshopify.com" } });
  logActivity(db, userA, "integration_connected", "Connected Shopify");

  await check("RECONNECT -> USE: the NEW token works, and the old token is nowhere retrievable", () => {
    const token = requireValidToken(userA, "shopify");
    assert.equal(token, tokenV2);
    assert.notEqual(token, tokenV1);
    const conn = getConnection(userA, "shopify");
    assert.equal(JSON.parse(conn.meta).shopDomain, "v2.myshopify.com", "meta was replaced, not merged with stale v1 data");
  });

  await check("no duplicate row was created by the reconnect — exactly one integrations row for this user+provider", () => {
    const n = rowCount("SELECT COUNT(*) AS n FROM integrations WHERE userId = ? AND provider = 'shopify'", userA);
    assert.equal(n, 1);
  });

  await check("encryption still works correctly across the reconnect — raw DB value is ciphertext, not either plaintext token", () => {
    const raw = db.prepare("SELECT accessToken FROM integrations WHERE userId = ? AND provider = 'shopify'").get(userA);
    assert.match(raw.accessToken, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    assert.ok(!raw.accessToken.includes(tokenV1) && !raw.accessToken.includes(tokenV2));
  });

  await check("audit history survives the full cycle intact (connect, disconnect, reconnect all present, in order)", () => {
    const rows = db.prepare("SELECT action FROM activity_logs WHERE userId = ? AND action IN ('integration_connected','integration_disconnected') ORDER BY createdAt ASC").all(userA);
    assert.deepEqual(rows.map((r) => r.action), ["integration_connected", "integration_disconnected", "integration_connected"]);
  });

  // --- Cross-user isolation through the same cycle -----------------------
  const userB = makeUser(`reconnect-b-${stamp}@example.com`);
  const userBToken = `user-b-token-${stamp}`;
  saveConnection(userB, "shopify", { accessToken: userBToken, expiresAt: null, scopes: [], meta: { shopDomain: "userb.myshopify.com" } });

  await check("cross-user: user A's reconnect never touched user B's separate connection to the same provider", () => {
    assert.equal(requireValidToken(userB, "shopify"), userBToken);
  });

  disconnectIntegration(userA, "shopify"); // reuse userA's connection for the next check

  await check("cross-user: disconnecting user A's integration does not disconnect user B's", () => {
    assert.equal(connectionHealth(userA, "shopify").connected, false);
    assert.equal(connectionHealth(userB, "shopify").connected, true, "user B is completely unaffected by user A's disconnect");
    assert.equal(requireValidToken(userB, "shopify"), userBToken);
  });

  // --- Personal integration must not be reachable through another user ---
  await check("a personal integration is not accessible through another user's account (different userId, same provider, no cross-read)", () => {
    // getConnection(userId, provider) is the only real read path — there is
    // no "get by connection id" path that could be handed a foreign id.
    // Confirm user B's own lookup can never surface user A's row by
    // checking the two are genuinely different rows with different tokens.
    const connA = getConnection(userA, "shopify"); // disconnected, so null token
    const connB = getConnection(userB, "shopify");
    assert.notEqual(connA?.id, connB?.id);
    assert.equal(connB.accessToken, userBToken);
  });

  // --- Org reconnect cycle + personal/org-A/org-B three-way coexistence
  // (Phase 18.1's partial-unique-index fix is exactly what makes this
  // legal — re-verified here end-to-end through a full reconnect) --------
  const owner = makeUser(`reconnect-owner-${stamp}@example.com`);
  const personalToken = `personal-woo-token-${stamp}`;
  saveConnection(owner, "woocommerce", { accessToken: personalToken, expiresAt: null, scopes: [], meta: { siteUrl: "https://personal.example.com" } });

  const orgA = makeOrg("Reconnect Org A", owner);
  const orgB = makeOrg("Reconnect Org B", owner);
  const orgATokenV1 = `org-a-woo-v1-${stamp}`;
  const orgBToken = `org-b-woo-token-${stamp}`;
  saveOrgConnection(orgA, owner, "woocommerce", { accessToken: orgATokenV1, expiresAt: null, scopes: [], meta: { siteUrl: "https://org-a.example.com" } });
  saveOrgConnection(orgB, owner, "woocommerce", { accessToken: orgBToken, expiresAt: null, scopes: [], meta: { siteUrl: "https://org-b.example.com" } });

  await check("three-way coexistence: the SAME user's personal connection and two different orgs' connections for the SAME provider are all independently readable", () => {
    assert.equal(getConnection(owner, "woocommerce").accessToken, personalToken);
    assert.equal(getOrgConnection(orgA, "woocommerce").accessToken, orgATokenV1);
    assert.equal(getOrgConnection(orgB, "woocommerce").accessToken, orgBToken);
  });

  const orgATokenV2 = `org-a-woo-v2-${stamp}`;
  disconnectOrgConnection(orgA, "woocommerce");
  saveOrgConnection(orgA, owner, "woocommerce", { accessToken: orgATokenV2, expiresAt: null, scopes: [], meta: { siteUrl: "https://org-a-v2.example.com" } });

  await check("org reconnect: org A's new token works, and neither the personal connection nor org B's connection were touched", () => {
    assert.equal(getOrgConnection(orgA, "woocommerce").accessToken, orgATokenV2);
    assert.equal(getConnection(owner, "woocommerce").accessToken, personalToken, "the SAME user's personal connection survived org A's disconnect+reconnect untouched");
    assert.equal(getOrgConnection(orgB, "woocommerce").accessToken, orgBToken, "org B's connection survived org A's disconnect+reconnect untouched");
  });

  await check("org reconnect created no duplicate row — exactly one integrations row for org A + woocommerce", () => {
    const n = rowCount("SELECT COUNT(*) AS n FROM integrations WHERE orgId = ? AND provider = 'woocommerce'", orgA);
    assert.equal(n, 1);
  });

  await check("org ownership (connectedByUserId) remains correct after reconnect", () => {
    const raw = db.prepare("SELECT userId FROM integrations WHERE orgId = ? AND provider = 'woocommerce'").get(orgA);
    assert.equal(raw.userId, owner);
  });

  // --- Cross-org: org B must never see org A's data, and vice versa -----
  const otherOwner = makeUser(`reconnect-otherowner-${stamp}@example.com`);
  const orgC = makeOrg("Reconnect Org C", otherOwner);
  const orgCToken = `org-c-woo-token-${stamp}`;
  saveOrgConnection(orgC, otherOwner, "woocommerce", { accessToken: orgCToken, expiresAt: null, scopes: [], meta: {} });

  await check("cross-org: org C (different owner entirely) cannot see org A's or org B's tokens, and vice versa", () => {
    assert.equal(getOrgConnection(orgC, "woocommerce").accessToken, orgCToken);
    assert.notEqual(getOrgConnection(orgC, "woocommerce").accessToken, orgATokenV2);
    assert.notEqual(getOrgConnection(orgC, "woocommerce").accessToken, orgBToken);
  });

  disconnectOrgConnection(orgC, "woocommerce");
  await check("cross-org: disconnecting org C never disconnects org A or org B", () => {
    assert.equal(getOrgConnection(orgC, "woocommerce").accessToken, null);
    assert.equal(getOrgConnection(orgA, "woocommerce").accessToken, orgATokenV2, "org A unaffected");
    assert.equal(getOrgConnection(orgB, "woocommerce").accessToken, orgBToken, "org B unaffected");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} reconnect + isolation checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Reconnect + isolation regression suite crashed:", err);
  process.exit(1);
});
