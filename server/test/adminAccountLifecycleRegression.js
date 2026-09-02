// Round 33 — admin-created closed-beta accounts + full account deletion.
// Real HTTP requests against a REAL, already-booted server (PLATFORM_ADMIN_EMAIL
// set so this suite can bootstrap a genuine platform admin via signup, same
// as adminPanelSecurityRegression.js — never by writing isPlatformAdmin=1
// directly), PLUS direct db.js reads to verify cascade/recompute
// side-effects HTTP responses alone can't show. Boots with
// PUBLIC_SIGNUP_ENABLED=false — the real production scenario this whole
// feature exists for — and creates every non-admin test account through
// the new admin route rather than public signup, proving the feature by
// using it, not by working around the closed gate.
//
//   PLATFORM_ADMIN_EMAIL=admin-test@example.com PUBLIC_SIGNUP_ENABLED=false node test/adminAccountLifecycleRegression.js [baseUrl]
import assert from "node:assert/strict";

const BASE = process.argv[2] || process.env.ADMIN_LIFECYCLE_TEST_BASE_URL || "http://localhost:4102";
const ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL;

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");

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
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* fine */ }
      return { status: res.status, json, text };
    },
  };
}

const stamp = Date.now();
const now = () => new Date().toISOString();

async function run() {
  if (!ADMIN_EMAIL) {
    console.error("PLATFORM_ADMIN_EMAIL must be set (matching the server's own env) so this suite can bootstrap a real platform admin via signup.");
    process.exit(1);
  }

  const adminSession = makeSession();
  const { json: adminSignup } = await adminSession.req("POST", "/api/auth/signup", { name: "Platform Admin", email: ADMIN_EMAIL, password: "TestPass123!" });
  const adminUser = adminSignup.user;
  assert.equal(adminUser.isPlatformAdmin, true, "the admin's own signup must still be exempt from the closed-signup gate");

  // --- Requirement #1: the gate is unweakened -----------------------
  await check("[gate] POST /api/auth/signup is still blocked for a non-admin email, with PUBLIC_SIGNUP_ENABLED=false, exactly as before this feature existed", async () => {
    const { status, json } = await adminSession.req("POST", "/api/auth/signup", { name: "Should Fail", email: `should-fail-${stamp}@example.com`, password: "TestPass123!" });
    assert.equal(status, 403);
    assert.match(json.error, /public signup is currently disabled/i);
    const row = db.prepare("SELECT id FROM users WHERE email = ?").get(`should-fail-${stamp}@example.com`);
    assert.equal(row, undefined, "no row must be inserted for the rejected signup attempt");
  });

  // --- Admin-created accounts -----------------------------------------
  let beta1;
  await check("[admin-create] admin can create a beta account while PUBLIC_SIGNUP_ENABLED=false, and the returned temp password logs in", async () => {
    const email = `beta1-${stamp}@example.com`;
    const { status, json } = await adminSession.req("POST", "/api/admin/users", { name: "Beta Tester One", email });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.email, email);
    assert.ok(json.tempPassword && json.tempPassword.length >= 12, "a real temp password must be returned");
    beta1 = json;

    const loginSession = makeSession();
    const { status: loginStatus, json: loginJson } = await loginSession.req("POST", "/api/auth/login", { email, password: json.tempPassword });
    assert.equal(loginStatus, 200, JSON.stringify(loginJson));
    assert.equal(loginJson.user.email, email);
  });

  await check("[admin-create] duplicate email is rejected the same way signup rejects it", async () => {
    const { status, json } = await adminSession.req("POST", "/api/admin/users", { name: "Duplicate", email: beta1.email });
    assert.equal(status, 400);
    assert.match(json.error, /already exists/i);
  });

  let beta2Session, beta2;
  await check("[admin-create] a non-admin gets 403 from POST /admin/users — creating this route did not create a second signup path", async () => {
    const email = `beta2-${stamp}@example.com`;
    const { json: createJson } = await adminSession.req("POST", "/api/admin/users", { name: "Beta Tester Two", email });
    beta2 = createJson;
    beta2Session = makeSession();
    await beta2Session.req("POST", "/api/auth/login", { email, password: createJson.tempPassword });

    const { status, json } = await beta2Session.req("POST", "/api/admin/users", { name: "Should Fail", email: `nope-${stamp}@example.com` });
    assert.equal(status, 403);
    assert.match(json.error, /platform admin/i);
  });

  await check("[admin-create] the admin_created_user audit entry is logged under the ADMIN's id, not the new user's", async () => {
    const row = db.prepare("SELECT description FROM activity_logs WHERE userId = ? AND action = 'admin_created_user' AND description LIKE ?").get(adminUser.id, `%${beta1.email}%`);
    assert.ok(row, "the admin's own activity_logs must contain the admin_created_user entry for beta1");
  });

  await check("[admin-create] GET /admin/users lists ONLY admin-created accounts, not the platform admin's own signup-created account", async () => {
    const { json } = await adminSession.req("GET", "/api/admin/users");
    const emails = json.map((u) => u.email);
    assert.ok(emails.includes(beta1.email), "beta1 must be listed");
    assert.ok(emails.includes(beta2.email), "beta2 must be listed");
    assert.ok(!emails.includes(ADMIN_EMAIL), "the admin's own account (createdByAdmin=0) must not appear in this list");
  });

  // --- Self-service deletion -------------------------------------------
  await check("[self-delete] a fresh account's own data (agent) is created, then DELETE /api/auth/me removes it and cascades", async () => {
    const { json: agent } = await beta2Session.req("POST", "/api/agents", { name: "Beta Agent", description: "test", instructions: "test" });
    assert.ok(agent.id, "sanity: the agent was really created");

    const { status, json } = await beta2Session.req("DELETE", "/api/auth/me");
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.email, beta2.email);

    assert.equal(db.prepare("SELECT id FROM users WHERE id = ?").get(beta2.id), undefined, "the user row must be gone");
    assert.equal(db.prepare("SELECT id FROM agents WHERE id = ?").get(agent.id), undefined, "the user's agent must cascade-delete");
    assert.equal(db.prepare("SELECT COUNT(*) c FROM activity_logs WHERE userId = ?").get(beta2.id).c, 0, "the deleted user's own activity_logs (including the self-delete entry itself) must cascade away with them");

    const { status: reAuthStatus } = await beta2Session.req("GET", "/api/auth/me");
    assert.equal(reAuthStatus, 401, "the session must be destroyed — no further authenticated requests succeed");
  });

  // --- Admin-triggered deletion -----------------------------------------
  await check("[admin-delete] admin can remove a beta account's access; it disappears from the admin list and the DB", async () => {
    const { status, json } = await adminSession.req("DELETE", `/api/admin/users/${beta1.id}`);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(db.prepare("SELECT id FROM users WHERE id = ?").get(beta1.id), undefined);

    const { json: list } = await adminSession.req("GET", "/api/admin/users");
    assert.ok(!list.some((u) => u.id === beta1.id), "removed account must no longer appear in the beta-accounts list");
  });

  await check("[admin-delete] the account_deleted audit entry survives under the ADMIN's id, naming it as an admin action", async () => {
    const row = db.prepare("SELECT description FROM activity_logs WHERE userId = ? AND action = 'account_deleted' AND description LIKE ?").get(adminUser.id, `%${beta1.email}%`);
    assert.ok(row, "the admin's own activity_logs must contain the account_deleted entry");
    assert.match(row.description, /admin action/i);
  });

  await check("[admin-delete] refuses to remove a platform admin through this route", async () => {
    const { status, json } = await adminSession.req("DELETE", `/api/admin/users/${adminUser.id}`);
    assert.equal(status, 403);
    assert.match(json.error, /platform admin/i);
    assert.notEqual(db.prepare("SELECT id FROM users WHERE id = ?").get(adminUser.id), undefined, "the admin account must still exist");
  });

  // --- Blockers: real cross-user data, never silently cascaded away ----
  async function makeBetaUser(label) {
    const email = `${label}-${stamp}@example.com`;
    const { json } = await adminSession.req("POST", "/api/admin/users", { name: label, email });
    return json;
  }

  await check("[delete blocker] an account that published marketplace content cannot be deleted — named, specific error", async () => {
    const seller = await makeBetaUser("seller1");
    db.prepare(
      "INSERT INTO marketplace_assets (id, creatorUserId, assetType, name, slug, createdAt, updatedAt) VALUES (?, ?, 'agent', 'Test Asset', ?, ?, ?)"
    ).run(cryptoRandom(), seller.id, `test-asset-${stamp}`, now(), now());

    const { status, json } = await adminSession.req("DELETE", `/api/admin/users/${seller.id}`);
    assert.equal(status, 400);
    assert.match(json.error, /published marketplace content/i);
    assert.notEqual(db.prepare("SELECT id FROM users WHERE id = ?").get(seller.id), undefined, "must not be partially deleted");
  });

  await check("[delete blocker] a buyer with a purchase on record cannot be deleted — protects the SELLER's transaction history", async () => {
    const buyer = await makeBetaUser("buyer1");
    const sellerForPurchase = await makeBetaUser("seller2");
    const assetId = cryptoRandom();
    db.prepare(
      "INSERT INTO marketplace_assets (id, creatorUserId, assetType, name, slug, createdAt, updatedAt) VALUES (?, ?, 'agent', 'Test Asset 2', ?, ?, ?)"
    ).run(assetId, sellerForPurchase.id, `test-asset-2-${stamp}`, now(), now());
    db.prepare(
      "INSERT INTO asset_purchases (id, assetId, buyerUserId, sellerUserId, amountCents, platformCommissionCents, sellerNetCents, createdAt) VALUES (?, ?, ?, ?, 1000, 100, 900, ?)"
    ).run(cryptoRandom(), assetId, buyer.id, sellerForPurchase.id, now());

    const { status, json } = await adminSession.req("DELETE", `/api/admin/users/${buyer.id}`);
    assert.equal(status, 400);
    assert.match(json.error, /purchase or sale/i);
  });

  await check("[delete blocker] an account that published a custom tool cannot be deleted", async () => {
    const toolMaker = await makeBetaUser("toolmaker1");
    db.prepare(
      "INSERT INTO custom_tools (id, creatorUserId, name, description, webhookUrl, webhookSecret, createdAt, updatedAt) VALUES (?, ?, ?, 'test', 'https://example.com/hook', 'secret', ?, ?)"
    ).run(cryptoRandom(), toolMaker.id, `custom.tool_${stamp}`, now(), now());

    const { status, json } = await adminSession.req("DELETE", `/api/admin/users/${toolMaker.id}`);
    assert.equal(status, 400);
    assert.match(json.error, /custom tool/i);
  });

  await check("[delete blocker] the platform admin's own self-delete is refused if they've created a coupon code — the gap found while reviewing the plan", async () => {
    await adminSession.req("POST", "/api/admin/coupons", { code: `LIFECYCLE${stamp}`, type: "trial", value: 14 });
    const { status, json } = await adminSession.req("DELETE", "/api/auth/me");
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, /coupon codes/i);
    assert.notEqual(db.prepare("SELECT id FROM users WHERE id = ?").get(adminUser.id), undefined, "the admin must still exist — refused, not partially applied");
  });

  await check("[delete blocker] refused if they've granted organization credits — reasons stack, proving each check runs independently rather than short-circuiting on the first one found", async () => {
    const creditGrantee = await makeBetaUser("creditgrantee1");
    const grantSession = makeSession();
    await grantSession.req("POST", "/api/auth/login", { email: creditGrantee.email, password: creditGrantee.tempPassword });
    const { json: org } = await grantSession.req("POST", "/api/organizations", { name: "Credit Test Org" });
    await adminSession.req("POST", `/api/admin/organizations/${org.id}/credits`, { amountCents: 500, reason: "test" });

    // The admin themself granted the credit (grantedBy = adminUser.id).
    // By now the admin ALSO has the blocking coupon from the prior check —
    // asserting BOTH reasons appear in the same message proves the
    // organization_credits check itself contributed a reason, not just
    // that the coupon_codes check alone was enough.
    const { status, json } = await adminSession.req("DELETE", "/api/auth/me");
    assert.equal(status, 400);
    assert.match(json.error, /coupon codes/i);
    assert.match(json.error, /organization credits/i);
  });

  // --- Safe auto-cleanup: the user's OWN participation records ----------
  await check("[delete cleanup] a departing user's own review, install, and report are cleaned up; the asset's cached rating and another review's helpfulCount are correctly recomputed", async () => {
    const assetOwner = await makeBetaUser("assetowner1");
    const reviewer = await makeBetaUser("reviewer1");
    const otherReviewer = await makeBetaUser("otherreviewer1");
    const assetId = cryptoRandom();
    db.prepare(
      "INSERT INTO marketplace_assets (id, creatorUserId, assetType, name, slug, createdAt, updatedAt) VALUES (?, ?, 'agent', 'Rated Asset', ?, ?, ?)"
    ).run(assetId, assetOwner.id, `rated-asset-${stamp}`, now(), now());

    // Two reviews — one by the user being deleted, one by someone else,
    // so ratingSum/ratingCount recompute is actually observable.
    db.prepare("INSERT INTO asset_reviews (id, assetId, userId, rating, createdAt, updatedAt) VALUES (?, ?, ?, 5, ?, ?)").run(cryptoRandom(), assetId, reviewer.id, now(), now());
    const otherReviewId = cryptoRandom();
    db.prepare("INSERT INTO asset_reviews (id, assetId, userId, rating, createdAt, updatedAt) VALUES (?, ?, ?, 3, ?, ?)").run(otherReviewId, assetId, otherReviewer.id, now(), now());
    db.prepare("UPDATE marketplace_assets SET ratingCount = 2, ratingSum = 8 WHERE id = ?").run(assetId);

    // The departing user also voted "helpful" on the OTHER review.
    db.prepare("INSERT INTO asset_review_votes (reviewId, userId, createdAt) VALUES (?, ?, ?)").run(otherReviewId, reviewer.id, now());
    db.prepare("UPDATE asset_reviews SET helpfulCount = 1 WHERE id = ?").run(otherReviewId);

    db.prepare(
      "INSERT INTO marketplace_installs (id, assetId, installedVersionId, installedByUserId, installedEntityType, installedEntityIds, createdAt, updatedAt) VALUES (?, ?, 'v1', ?, 'agent', '[]', ?, ?)"
    ).run(cryptoRandom(), assetId, reviewer.id, now(), now());
    db.prepare("INSERT INTO asset_reports (id, assetId, reporterUserId, reason, createdAt) VALUES (?, ?, ?, 'spam', ?)").run(cryptoRandom(), assetId, reviewer.id, now());

    const { status, json } = await adminSession.req("DELETE", `/api/admin/users/${reviewer.id}`);
    assert.equal(status, 200, JSON.stringify(json));

    assert.equal(db.prepare("SELECT COUNT(*) c FROM asset_reviews WHERE userId = ?").get(reviewer.id).c, 0, "their own review must be gone");
    assert.equal(db.prepare("SELECT COUNT(*) c FROM marketplace_installs WHERE installedByUserId = ?").get(reviewer.id).c, 0, "their install record must be gone");
    assert.equal(db.prepare("SELECT COUNT(*) c FROM asset_reports WHERE reporterUserId = ?").get(reviewer.id).c, 0, "their report must be gone");
    assert.equal(db.prepare("SELECT COUNT(*) c FROM asset_review_votes WHERE userId = ?").get(reviewer.id).c, 0, "their vote must be gone");

    const asset = db.prepare("SELECT ratingCount, ratingSum FROM marketplace_assets WHERE id = ?").get(assetId);
    assert.equal(asset.ratingCount, 1, "ratingCount must be recomputed down to just the remaining review");
    assert.equal(asset.ratingSum, 3, "ratingSum must be recomputed down to just the remaining review's rating");

    const otherReview = db.prepare("SELECT helpfulCount FROM asset_reviews WHERE id = ?").get(otherReviewId);
    assert.equal(otherReview.helpfulCount, 0, "the other review's helpfulCount must be recomputed down after the departing user's vote was removed");
  });

  // --- Owned organization cascades exactly like self-service org delete -
  await check("[delete cleanup] an organization the deleted user solely owns is gone too, via the same deleteOrganization() the self-service org-delete route already uses", async () => {
    const orgOwner = await makeBetaUser("orgowner1");
    const ownerSession = makeSession();
    await ownerSession.req("POST", "/api/auth/login", { email: orgOwner.email, password: orgOwner.tempPassword });
    const { json: org } = await ownerSession.req("POST", "/api/organizations", { name: "Solo Org" });
    assert.ok(org.id, "sanity: org was created");

    const { status } = await adminSession.req("DELETE", `/api/admin/users/${orgOwner.id}`);
    assert.equal(status, 200);
    assert.equal(db.prepare("SELECT id FROM organizations WHERE id = ?").get(org.id), undefined, "the solely-owned org must be gone too");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} admin account lifecycle checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Admin account lifecycle regression suite crashed:", err);
  process.exit(1);
});
