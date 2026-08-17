// CI-only fixture provisioning — signs up a fresh user, creates an org, and
// creates a full-scope developer API key, then prints the raw key to
// stdout. Used by .github/workflows/ci.yml to get a real API key for the
// JS/Python SDK smoke tests to run against, without hand-copying one.
// Same plain-script style (no test framework) as server/test/*.js.
//
// Usage: node test/ci-provision-api-key.js [baseUrl]
const BASE = process.argv[2] || process.env.CI_BASE_URL || "http://localhost:4000";

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

const ALL_SCOPES = [
  "agents:read", "agents:execute",
  "automations:read", "automations:execute",
  "content:generate",
  "files:read", "files:write",
  "integrations:read", "integrations:execute",
  "marketplace:read",
  "projects:read", "projects:write",
  "tasks:read", "tasks:write",
  "webhooks:manage",
];

async function main() {
  const session = makeSession();
  const stamp = Date.now();
  const email = `sdk-ci-${stamp}@example.com`;

  const signupRes = await session.req("POST", "/api/auth/signup", { email, password: "CiSmokeTest123!", name: "SDK CI Smoke Test" });
  if (signupRes.status !== 200 && signupRes.status !== 201) {
    throw new Error(`Signup failed (${signupRes.status}): ${JSON.stringify(signupRes.json)}`);
  }

  const orgRes = await session.req("POST", "/api/organizations", { name: "SDK CI Smoke Test Org" });
  if (!orgRes.json?.id) throw new Error(`Org creation failed: ${JSON.stringify(orgRes.json)}`);
  const orgId = orgRes.json.id;

  const keyRes = await session.req("POST", `/api/organizations/${orgId}/developer/api-keys`, {
    name: "SDK CI smoke test key",
    scopes: ALL_SCOPES,
  });
  if (!keyRes.json?.rawKey) throw new Error(`API key creation failed: ${JSON.stringify(keyRes.json)}`);

  // Only the raw key on stdout — CI captures this into an env var. Nothing
  // else goes to stdout so a simple `$(node ci-provision-api-key.js)`
  // capture works without extra parsing.
  process.stdout.write(keyRes.json.rawKey);
}

main().catch((err) => {
  console.error("ci-provision-api-key failed:", err.message);
  process.exit(1);
});
