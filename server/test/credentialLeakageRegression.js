// Phase 18.1 §2 — OAuth/integration credential leakage regression suite.
// A plain Node script (same pattern as test/securityRegression.js) run
// against a REAL, already-booted server. Seeds real connections directly
// through the same functions the app's own routes use (saveConnection /
// saveOrgConnection / logActivity) — bypassing only the "verify against
// the real external provider" network hop, since no real WordPress/
// WooCommerce/Shopify store is reachable in this sandbox — then hits the
// real HTTP read endpoints and inspects real DB rows to confirm the
// secret value never appears anywhere it shouldn't.
//
//   node test/credentialLeakageRegression.js [baseUrl]
//
// Exits non-zero if any check fails.
import assert from "node:assert/strict";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { logActivity } from "../middleware.js";
import { saveConnection, saveOrgConnection } from "../integrations/manager.js";

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
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON, fine */ }
      return { status: res.status, json, text };
    },
  };
}

async function signup(session, email, name) {
  const { json } = await session.req("POST", "/api/auth/signup", { email, password: "TestPass123!", name });
  return json.user;
}

const stamp = Date.now();
const WOO_SECRET = `cs_leak_test_secret_${stamp}`;
const WOO_KEY = `ck_leak_test_key_${stamp}`;
const WP_SECRET = `wp_leak_test_app_password_${stamp}`;

function assertNoLeak(haystack, secret, label) {
  assert.ok(!String(haystack).includes(secret), `${label} must not contain the secret value`);
}

async function run() {
  const sess = makeSession();
  const user = await signup(sess, `leak-test-${stamp}@example.com`, "Leak Test User");

  // --- personal WooCommerce connection, seeded directly (same call the
  // real /connect route makes after a successful checkStore()) ---
  saveConnection(user.id, "woocommerce", {
    accessToken: WOO_SECRET,
    expiresAt: null,
    scopes: [],
    meta: { siteUrl: "https://leak-test-store.example.com", consumerKey: WOO_KEY },
  });
  logActivity(db, user.id, "integration_connected", "Connected WooCommerce");

  await check("personal WooCommerce /status response never contains the secret", async () => {
    const { text } = await sess.req("GET", "/api/integrations/woocommerce/status");
    assertNoLeak(text, WOO_SECRET, "GET /api/integrations/woocommerce/status body");
  });

  await check("raw integrations.accessToken column is not the plaintext secret", () => {
    const row = db.prepare("SELECT accessToken FROM integrations WHERE userId = ? AND provider = 'woocommerce'").get(user.id);
    assertNoLeak(row.accessToken, WOO_SECRET, "raw integrations.accessToken");
  });

  await check("activity_logs entry for the connect event does not contain the secret", () => {
    const rows = db.prepare("SELECT description FROM activity_logs WHERE userId = ? AND action = 'integration_connected'").all(user.id);
    for (const r of rows) assertNoLeak(r.description, WOO_SECRET, "activity_logs.description");
  });

  // --- org-level connections (WordPress + WooCommerce), seeded the same
  // way routes/orgIntegrations.js's /connect handler does after a
  // successful verify() ---
  const { json: org } = await sess.req("POST", "/api/organizations", { name: `Leak Test Org ${stamp}` });
  saveOrgConnection(org.id, user.id, "wordpress", {
    accessToken: WP_SECRET,
    expiresAt: null,
    scopes: [],
    meta: { siteUrl: "https://leak-test-wp.example.com", username: "admin" },
  });
  saveOrgConnection(org.id, user.id, "woocommerce", {
    accessToken: WOO_SECRET,
    expiresAt: null,
    scopes: [],
    meta: { siteUrl: "https://leak-test-store.example.com", consumerKey: WOO_KEY },
  });
  logActivity(db, user.id, "org_integration_connected", "Connected WordPress for the organization", { orgId: org.id });
  logActivity(db, user.id, "org_integration_connected", "Connected WooCommerce for the organization", { orgId: org.id });

  await check("org integrations list response never contains either secret", async () => {
    const { text, json } = await sess.req("GET", `/api/organizations/${org.id}/integrations`);
    assertNoLeak(text, WP_SECRET, "GET /:orgId/integrations body (WordPress secret)");
    assertNoLeak(text, WOO_SECRET, "GET /:orgId/integrations body (WooCommerce secret)");
    assert.ok(Array.isArray(json) && json.some((c) => c.provider === "woocommerce" && c.connected), "sanity: woocommerce shows as connected in the catalog response");
  });

  await check("org-level raw integrations rows are not plaintext, and meta excludes the secret", () => {
    const rows = db.prepare("SELECT provider, accessToken, meta FROM integrations WHERE orgId = ?").all(org.id);
    assert.equal(rows.length, 2, "both org connections were written");
    for (const r of rows) {
      assertNoLeak(r.accessToken, WOO_SECRET, `raw org integrations.accessToken (${r.provider})`);
      assertNoLeak(r.accessToken, WP_SECRET, `raw org integrations.accessToken (${r.provider})`);
      const meta = JSON.parse(r.meta || "{}");
      assert.ok(!("consumerSecret" in meta), `${r.provider} meta must not contain a raw consumerSecret field`);
      assert.ok(!("appPassword" in meta), `${r.provider} meta must not contain a raw appPassword field`);
      assertNoLeak(r.meta, WOO_SECRET, `${r.provider} meta JSON`);
      assertNoLeak(r.meta, WP_SECRET, `${r.provider} meta JSON`);
    }
  });

  await check("org activity_logs entries do not contain either secret", () => {
    const rows = db.prepare("SELECT description FROM activity_logs WHERE orgId = ? AND action = 'org_integration_connected'").all(org.id);
    assert.ok(rows.length >= 2, "connect activity was logged for both providers");
    for (const r of rows) {
      assertNoLeak(r.description, WP_SECRET, "org activity_logs.description");
      assertNoLeak(r.description, WOO_SECRET, "org activity_logs.description");
    }
  });

  // --- disconnect must not leave anything readable behind ---
  await check("org disconnect clears both encrypted columns (no leftover ciphertext)", async () => {
    await sess.req("POST", `/api/organizations/${org.id}/integrations/woocommerce/disconnect`);
    const row = db.prepare("SELECT accessToken, refreshToken FROM integrations WHERE orgId = ? AND provider = 'woocommerce'").get(org.id);
    assert.equal(row.accessToken, null, "accessToken is cleared, not left as stale ciphertext");
    assert.equal(row.refreshToken, null, "refreshToken is cleared, not left as stale ciphertext");
  });

  // --- WooCommerce API client credential-in-URL check (Phase 18.1 §2 fix:
  // real request over HTTPS must use Basic Auth, never a query string) ---
  await check("WooCommerce API client sends HTTPS credentials via Basic Auth, never in the URL", async () => {
    const { checkStore } = await import("../integrations/woocommerce/api.js");
    const originalFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url: url.toString(), headers: opts.headers };
      return { ok: true, json: async () => ({ environment: { site_url: "x", version: "1" } }) };
    };
    try {
      await checkStore("https://leak-test-store.example.com", WOO_KEY, WOO_SECRET);
    } finally {
      global.fetch = originalFetch;
    }
    assertNoLeak(captured.url, WOO_SECRET, "WooCommerce HTTPS request URL");
    assert.ok(captured.headers.authorization?.startsWith("Basic "), "WooCommerce HTTPS request uses a Basic Auth header");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} credential-leakage checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Credential leakage regression suite crashed:", err);
  process.exit(1);
});
