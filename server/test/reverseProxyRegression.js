// Phase 18.1 §7 — dedicated regression pass for the Phase 18 trust-proxy
// fix (index.js: `app.set("trust proxy", 1)` only when NODE_ENV=production).
// Real HTTP requests against a REAL, already-booted server — this script
// does NOT boot the server itself, since the whole point is testing two
// DIFFERENT boot configurations (trust-proxy off vs on), which differ by
// NODE_ENV at process start. Run it twice, once against each:
//
//   node test/reverseProxyRegression.js direct  <baseUrl>   (NODE_ENV != production)
//   node test/reverseProxyRegression.js proxy   <baseUrl>   (NODE_ENV = production)
//
// "proxy" mode simulates the untrusted-hop boundary by sending
// X-Forwarded-For / X-Forwarded-Proto directly from the test client, since
// with `trust proxy: 1` the app trusts exactly one hop — in a real
// deployment that hop is the actual reverse proxy; here the test client
// plays that role directly, which is the correct way to exercise the
// Express-level trust boundary without standing up real nginx/TLS. This
// also demonstrates the resulting infrastructure requirement: with trust
// proxy on, whoever can open a direct TCP connection to this process can
// spoof X-Forwarded-For — production deployments MUST keep the app
// unreachable except through the real, configured proxy.
import assert from "node:assert/strict";

const MODE = process.argv[2]; // "direct" | "proxy"
const BASE = process.argv[3] || process.env.BASE_URL || "http://localhost:4102";
if (MODE !== "direct" && MODE !== "proxy") {
  console.error('Usage: node test/reverseProxyRegression.js <direct|proxy> [baseUrl]');
  process.exit(2);
}

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

function makeSession(extraHeaders = {}) {
  let cookies = [];
  return {
    async req(method, path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
          ...(cookies.length ? { Cookie: cookies.join("; ") } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
      for (const sc of setCookies) {
        const pair = sc.split(";")[0];
        const name = pair.split("=")[0];
        cookies = cookies.filter((c) => !c.startsWith(name + "="));
        cookies.push(pair);
      }
      let json = null;
      try { json = await res.json(); } catch { /* fine */ }
      return { status: res.status, json, rawSetCookies: setCookies };
    },
  };
}

const stamp = Date.now();

async function runDirectMode() {
  console.log(`Reverse-proxy regression suite — DIRECT mode (no proxy trusted) against ${BASE}\n`);

  // Runs before the rate-limit-exhaustion check below, which deliberately
  // burns this real IP's entire signup allowance for the next 60s.
  await check("dev/direct: X-Forwarded-Proto: https does not make the session cookie Secure (dev cookie.secure is NODE_ENV-gated, not header-gated)", async () => {
    const sess = makeSession({ "X-Forwarded-Proto": "https" });
    const { rawSetCookies } = await sess.req("POST", "/api/auth/signup", {
      email: `proxy-scheme-direct-${stamp}@example.com`, password: "TestPass123!", name: "Scheme Test",
    });
    const sidCookie = rawSetCookies.find((c) => c.startsWith("autopilon.sid="));
    assert.ok(sidCookie, "a session cookie was set");
    assert.ok(!/;\s*Secure/i.test(sidCookie), "cookie is not marked Secure outside production, even if X-Forwarded-Proto claims https");
  });

  await check("dev/direct: spoofed X-Forwarded-For does NOT get its own rate-limit bucket (proxy headers not blindly trusted)", async () => {
    // Without trust proxy configured, req.ip is always the real socket peer
    // regardless of what X-Forwarded-For claims — so 10 more signups (this
    // real IP has 9 of its 10-per-60s allowance left after the check
    // above), each claiming a DIFFERENT fake client IP, must still all
    // count against the SAME real bucket and the last must be rate-limited,
    // exactly as if no header had been sent at all.
    let lastStatus = null;
    for (let i = 0; i < 10; i++) {
      const sess = makeSession({ "X-Forwarded-For": `203.0.113.${i}` });
      const { status } = await sess.req("POST", "/api/auth/signup", {
        email: `proxy-spoof-direct-${stamp}-${i}@example.com`, password: "TestPass123!", name: "Spoof Test",
      });
      lastStatus = status;
    }
    assert.equal(lastStatus, 429, "the final signup, despite claiming a new fake IP each time, is still rate-limited (all shared one real bucket, already primed by the check above)");
  });
}

async function runProxyMode() {
  console.log(`Reverse-proxy regression suite — PROXY mode (trust proxy: 1, NODE_ENV=production) against ${BASE}\n`);

  await check("prod/proxy: Set-Cookie has the Secure flag when the trusted hop reports X-Forwarded-Proto: https", async () => {
    const sess = makeSession({ "X-Forwarded-Proto": "https" });
    const { status, rawSetCookies } = await sess.req("POST", "/api/auth/signup", {
      email: `proxy-secure-${stamp}@example.com`, password: "TestPass123!", name: "Secure Cookie Test",
    });
    assert.equal(status, 200, "signup succeeded");
    const sidCookie = rawSetCookies.find((c) => c.startsWith("autopilon.sid="));
    assert.ok(sidCookie, "a session cookie was set");
    assert.ok(/;\s*Secure/i.test(sidCookie), "cookie IS marked Secure when the trusted proxy reports https (this is the Phase 18 fix under test)");
    assert.ok(/;\s*HttpOnly/i.test(sidCookie), "cookie is HttpOnly");
    assert.ok(/SameSite=Lax/i.test(sidCookie), "cookie is SameSite=Lax");
    assert.ok(/Expires=/i.test(sidCookie), "cookie carries an Expires attribute (session expiration is configured — express-session serializes maxAge as Expires, not Max-Age)");
  });

  await check("prod/proxy: with NO X-Forwarded-Proto at all, no session cookie is sent (fail-safe — not a downgrade to a non-Secure cookie)", async () => {
    // cookie.secure: true means express-session refuses to set the cookie
    // on what it perceives as an insecure connection (req.secure === false,
    // since there's no trusted signal saying otherwise) — it does NOT fall
    // back to sending the cookie without the Secure flag. This is the
    // correct, fail-safe behavior: if the real proxy in front of this app
    // ever stops sending X-Forwarded-Proto correctly, users simply can't
    // log in (a loud, visible failure) rather than silently getting a
    // session cookie that could leak over plain HTTP.
    const sess = makeSession({}); // no X-Forwarded-Proto — simulates a broken/missing proxy hop, or a request reaching the app without going through it
    const { status, rawSetCookies } = await sess.req("POST", "/api/auth/signup", {
      email: `proxy-insecure-${stamp}@example.com`, password: "TestPass123!", name: "No Scheme Test",
    });
    assert.equal(status, 200, "the signup call itself still succeeds (the user account IS created)");
    const sidCookie = rawSetCookies.find((c) => c.startsWith("autopilon.sid="));
    assert.ok(!sidCookie, "no session cookie is sent at all — never a cookie missing the Secure flag");
    const { status: meStatus } = await sess.req("GET", "/api/auth/me");
    assert.equal(meStatus, 401, "with no session cookie ever received, the client is correctly left unauthenticated");
  });

  await check("prod/proxy: login/session persistence/logout across the trusted-proxy path", async () => {
    const sess = makeSession({ "X-Forwarded-Proto": "https" });
    const email = `proxy-session-${stamp}@example.com`;
    const { status: signupStatus } = await sess.req("POST", "/api/auth/signup", { email, password: "TestPass123!", name: "Session Test" });
    assert.equal(signupStatus, 200, "signup succeeded");

    const { status: meStatus1, json: me1 } = await sess.req("GET", "/api/auth/me");
    assert.equal(meStatus1, 200, "session persists for an authenticated follow-up request through the same trusted-proxy path");
    assert.equal(me1.user.email, email);

    const { status: logoutStatus } = await sess.req("POST", "/api/auth/logout");
    assert.equal(logoutStatus, 200, "logout succeeded");

    const { status: meStatus2 } = await sess.req("GET", "/api/auth/me");
    assert.equal(meStatus2, 401, "after logout, the same cookie no longer authenticates");
  });

  await check("prod/proxy: distinct real clients behind the SAME proxy get INDEPENDENT rate-limit buckets (correct client IP handling)", async () => {
    // Two different simulated real clients (distinct X-Forwarded-For, as a
    // real LB would set per actual client) must not share a rate-limit
    // bucket — each gets its own 10-per-60s allowance.
    const clientA = "198.51.100.10";
    const clientB = "198.51.100.20";
    let statusesA = [];
    for (let i = 0; i < 10; i++) {
      const sess = makeSession({ "X-Forwarded-For": clientA, "X-Forwarded-Proto": "https" });
      const { status } = await sess.req("POST", "/api/auth/signup", { email: `proxy-clientA-${stamp}-${i}@example.com`, password: "TestPass123!", name: "Client A" });
      statusesA.push(status);
    }
    assert.ok(statusesA.every((s) => s === 200 || s === 409), "client A's own 10 requests all succeeded within its own bucket");

    const sessB = makeSession({ "X-Forwarded-For": clientB, "X-Forwarded-Proto": "https" });
    const { status: statusB } = await sessB.req("POST", "/api/auth/signup", { email: `proxy-clientB-${stamp}@example.com`, password: "TestPass123!", name: "Client B" });
    assert.equal(statusB, 200, "client B, a distinct real client behind the same proxy, is NOT blocked by client A's rate-limit usage");
  });

  await check("prod/proxy: a spoofed X-Forwarded-For from a DIRECT connection is honored by the app (documents the required infra boundary, not a code bug)", async () => {
    // With trust proxy:1, the app trusts exactly one hop back — whoever
    // connects directly IS that trusted hop from the app's point of view.
    // This is inherent to numeric trust-proxy config, matching Express's
    // documented behavior; it's why production deployments must make sure
    // only the real proxy can reach this process directly. Verified here
    // so this property is never silently assumed away.
    const sess = makeSession({ "X-Forwarded-For": "10.10.10.1" });
    const { status } = await sess.req("POST", "/api/auth/signup", { email: `proxy-directspoof-${stamp}@example.com`, password: "TestPass123!", name: "Direct Spoof" });
    assert.equal(status, 200, "a direct connection claiming an arbitrary X-Forwarded-For is accepted as that IP when trust proxy is on — expected Express behavior, and why network isolation behind the real proxy is a required deployment precondition");
  });
}

async function run() {
  if (MODE === "direct") await runDirectMode();
  else await runProxyMode();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (${MODE} mode).`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Reverse-proxy regression suite crashed:", err);
  process.exit(1);
});
