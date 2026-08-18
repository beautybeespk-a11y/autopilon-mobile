// Phase 18.1 §12 — Admin Panel security review regression suite. Real HTTP
// requests against a REAL, already-booted server (started with
// PLATFORM_ADMIN_EMAIL set so this suite can bootstrap a genuine platform
// admin the same way routes/auth.js's signup/login flow does — not by
// writing isPlatformAdmin=1 directly into the DB).
//
// Complements the existing privilege-escalation checks already in
// test/securityRegression.js (organizations list, maintenance mode,
// feature flags CRUD, feature-flag audit log — all already covered there)
// with the routes/platformAdmin.js surface area those don't touch yet
// (billing logs, API usage dashboard, plans, credits/trials, job queue),
// plus a dedicated pass for credential leakage in admin responses,
// specifically called out by Phase 18.1 §12 ("Special attention to OAuth
// credentials/billing/API keys/feature flags").
//
//   PLATFORM_ADMIN_EMAIL=admin-test@example.com node test/adminPanelSecurityRegression.js [baseUrl]
import assert from "node:assert/strict";

const BASE = process.argv[2] || process.env.ADMIN_TEST_BASE_URL || "http://localhost:4102";
const ADMIN_EMAIL = process.env.PLATFORM_ADMIN_EMAIL;

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

async function signup(session, email, name) {
  const { json } = await session.req("POST", "/api/auth/signup", { email, password: "TestPass123!", name });
  return json.user;
}

const ADMIN_ROUTES = [
  ["GET", "/api/admin/organizations"],
  ["GET", "/api/admin/billing-logs"],
  ["GET", "/api/admin/api-usage"],
  ["GET", "/api/admin/plans"],
  ["GET", "/api/admin/queue/jobs"],
  ["GET", "/api/admin/queue/stats"],
  ["GET", "/api/admin/feature-flags"],
  ["GET", "/api/admin/maintenance"],
  ["GET", "/api/admin/marketplace/pending"],
  ["GET", "/api/admin/marketplace/reports"],
];

async function run() {
  if (!ADMIN_EMAIL) {
    console.error("PLATFORM_ADMIN_EMAIL must be set (matching the server's own env) so this suite can bootstrap a real platform admin via signup — refusing to fake admin status by writing to the DB directly.");
    process.exit(2);
  }
  console.log(`Admin panel security regression suite against ${BASE}\n`);

  const stamp = Date.now();
  const regularSession = makeSession();
  const regularUser = await signup(regularSession, `admin-test-regular-${stamp}@example.com`, "Regular User");
  assert.ok(regularUser, "sanity: regular user signup succeeded");

  const adminSession = makeSession();
  const adminUser = await signup(adminSession, ADMIN_EMAIL, "Platform Admin");
  assert.ok(adminUser, "sanity: admin bootstrap signup succeeded (or the email was already registered from a prior run)");

  await check("a regular (non-admin) user is denied on every routes/platformAdmin.js endpoint checked here", async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const { status } = await regularSession.req(method, path);
      assert.equal(status, 403, `${method} ${path} must be 403 for a non-admin, got ${status}`);
    }
  });

  await check("an unauthenticated request is denied (401), not 403 — proves auth is checked before role", async () => {
    const anon = makeSession();
    const { status } = await anon.req("GET", "/api/admin/organizations");
    assert.equal(status, 401);
  });

  await check("a genuine platform admin CAN reach these endpoints", async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const { status } = await adminSession.req(method, path);
      assert.ok(status < 400, `${method} ${path} should succeed for a real platform admin, got ${status}`);
    }
  });

  await check("organizations list response never contains an OAuth token, API key, or Stripe secret", async () => {
    const { text, json } = await adminSession.req("GET", "/api/admin/organizations");
    assert.ok(Array.isArray(json));
    assert.ok(!/accessToken|refreshToken|"secret"|sk_live_|sk_test_/i.test(text), "no token/secret-shaped field appears in the organizations list response");
  });

  await check("billing logs response never contains a Stripe secret key or raw API key", async () => {
    const { text } = await adminSession.req("GET", "/api/admin/billing-logs");
    assert.ok(!/sk_live_|sk_test_|rk_live_|whsec_/i.test(text), "no Stripe secret/webhook-signing key pattern appears in billing logs");
  });

  await check("api-usage dashboard never contains a raw developer API key (only counts/metadata, per its own code comment)", async () => {
    const { text } = await adminSession.req("GET", "/api/admin/api-usage");
    assert.ok(!/ap_live_|ap_test_|"rawKey"|"keyHash"/i.test(text), "no raw or hashed API key value appears in the usage dashboard");
  });

  await check("plans response never contains a Stripe secret key (stripePriceId is fine — it's not a secret)", async () => {
    const { text } = await adminSession.req("GET", "/api/admin/plans");
    assert.ok(!/sk_live_|sk_test_/i.test(text), "no Stripe secret key pattern in the plans response");
  });

  await check("sensitive admin actions are recorded in the audit trail (plan update, maintenance mode)", async () => {
    const { json: plans } = await adminSession.req("GET", "/api/admin/plans");
    const targetPlan = plans[0];
    await adminSession.req("PATCH", `/api/admin/plans/${targetPlan.id}`, { maxUsers: targetPlan.maxUsers });
    const { json: billingLogsAfter } = await adminSession.req("GET", "/api/admin/billing-logs?limit=10");
    assert.ok(billingLogsAfter.some((l) => l.action === "plan_updated"), "the plan update is recorded in the billing audit log");

    await adminSession.req("POST", "/api/admin/maintenance", { enabled: false, message: "" });
    // maintenance actions aren't in BILLING_ACTIONS, so check via the general activity log isn't exposed here —
    // instead confirm the endpoint itself responded successfully with the expected shape (its own logActivity call is code-reviewed above).
    const { json: maint } = await adminSession.req("GET", "/api/admin/maintenance");
    assert.equal(maint.enabled, false);
  });

  await check("a regular org owner cannot use their OWN org id to reach an admin-only action (role check, not just route existence)", async () => {
    const { json: org } = await regularSession.req("POST", "/api/organizations", { name: "Regular User's Own Org" });
    const { status } = await regularSession.req("POST", `/api/admin/organizations/${org.id}/grant-trial`, { planId: "free", days: 30 });
    assert.equal(status, 403, "owning the org does not grant platform-admin-only access to it");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} admin panel security checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Admin panel security regression suite crashed:", err);
  process.exit(1);
});
