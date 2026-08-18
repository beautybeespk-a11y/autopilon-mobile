// Phase 18.1 §10/§11 — secret-scan follow-up: a permanent regression test
// for the structured logger's redaction (config/logger.js's redact()) and
// for the fact that nothing this app logs ever includes a real
// password/token value. Two parts:
//
//   1. A direct unit check of redact() itself — sensitive-looking keys are
//      stripped no matter how deep they're nested.
//   2. A real, end-to-end check: sign up and log in with a unique,
//      distinctive password against an ALREADY-BOOTED server whose stdout
//      is being captured to a file, then grep that captured log file for
//      the raw password string — it must never appear, proving
//      requestLogger() (config/requestLogging.js) and every other log
//      call site along the signup/login path never logs the request body.
//
//   node test/productionLoggingRegression.js <baseUrl> <serverLogFilePath>
import assert from "node:assert/strict";
import fs from "node:fs";
import { logger } from "../config/logger.js";

const BASE = process.argv[2] || process.env.BASE_URL || "http://localhost:4102";
const LOG_FILE = process.argv[3];

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

// Captures whatever a logger.* call actually writes, by swapping the
// underlying stream briefly — real code path, not a reimplementation of
// redact()'s logic.
function captureLoggerOutput(fn) {
  const chunks = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  process.stderr.write = (chunk) => { chunks.push(chunk.toString()); return true; }; // logger.warn/error write here, not stdout
  try {
    fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return chunks.join("");
}

async function run() {
  console.log(`Production logging regression suite against ${BASE}\n`);

  await check("redact(): a top-level password/token/secret/apiKey field is stripped", () => {
    const out = captureLoggerOutput(() => {
      logger.info("test.event", { password: "hunter2", token: "abc123real", secret: "s3cr3t", apiKey: "key_real_value", userId: "u1" });
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.password, "[REDACTED]");
    assert.equal(parsed.token, "[REDACTED]");
    assert.equal(parsed.secret, "[REDACTED]");
    assert.equal(parsed.apiKey, "[REDACTED]");
    assert.equal(parsed.userId, "u1", "non-sensitive fields pass through untouched");
    assert.ok(!out.includes("hunter2") && !out.includes("abc123real") && !out.includes("s3cr3t") && !out.includes("key_real_value"), "none of the real values leaked into the raw log line");
  });

  await check("redact(): a NESTED sensitive field (inside a context object) is also stripped", () => {
    const out = captureLoggerOutput(() => {
      logger.info("test.nested_event", { requestId: "r1", details: { accessToken: "ya29.real-nested-token", meta: { refreshToken: "1//real-nested-refresh" } } });
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.details.accessToken, "[REDACTED]");
    assert.equal(parsed.details.meta.refreshToken, "[REDACTED]");
    assert.ok(!out.includes("ya29.real-nested-token") && !out.includes("1//real-nested-refresh"), "nested real values did not leak into the raw log line");
  });

  await check("redact(): an authorization/cookie field is stripped regardless of casing", () => {
    const out = captureLoggerOutput(() => {
      logger.warn("test.headers_event", { Authorization: "Bearer real-bearer-token-value", Cookie: "autopilon.sid=real-session-id" });
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.Authorization, "[REDACTED]");
    assert.equal(parsed.Cookie, "[REDACTED]");
  });

  if (LOG_FILE) {
    await check("end-to-end: a real signup+login password never appears in the live server's captured log output", async () => {
      const stamp = Date.now();
      const email = `logging-audit-${stamp}@example.com`;
      const distinctivePassword = `Xk9!VeryDistinctivePassword${stamp}Zq`;

      await fetch(`${BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: distinctivePassword, name: "Logging Audit" }),
      });
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: distinctivePassword }),
      });
      // Also a deliberately WRONG password, to confirm the failed-login
      // path (which does its own logActivity call) doesn't log it either.
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: distinctivePassword + "-wrong" }),
      });

      await new Promise((r) => setTimeout(r, 200)); // let the log lines actually flush to disk
      const logContent = fs.readFileSync(LOG_FILE, "utf8");
      assert.ok(!logContent.includes(distinctivePassword), "the real password never appears anywhere in the captured server log output");
    });
  } else {
    console.log("  (end-to-end log-file check skipped — no server log file path passed as argv[3])");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} production logging checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Production logging regression suite crashed:", err);
  process.exit(1);
});
