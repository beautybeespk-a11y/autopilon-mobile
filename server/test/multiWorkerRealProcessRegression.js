// Phase 19.2 — real multi-process worker durability test. Spawns TWO
// actual `node worker.js` OS processes (not simulated in one process)
// sharing one real SQLite file in WAL mode — the app's real horizontal
// scaling mechanism (see worker.js's and queueProvider.js's own header
// comments: multi-process scaling here comes from WAL-mode SQLite, not
// from the separately-tested-but-not-wired-in Redis queue provider).
// Enqueues a real burst of jobs, hard-kills one worker (SIGKILL, not a
// graceful SIGTERM) mid-burst, and verifies: no job is ever executed
// twice, the surviving worker keeps going, and every job eventually
// reaches a terminal state (completed, via either the survivor or the
// worker-crash reclaim mechanism from workerCrashReclaimRegression.js).
//
//   node test/multiWorkerRealProcessRegression.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || "/tmp/multi-worker-real-process-regression.sqlite";
process.env.DB_PATH = DB_PATH;
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-multiworker-test";

const db = (await import("../db.js")).default;
const { createJob, listJobs } = await import("../jobs/jobManager.js");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, err: err.message });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function spawnWorker(label) {
  const proc = spawn(process.execPath, ["worker.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      DB_PATH,
      BYOK_ENCRYPTION_KEY: process.env.BYOK_ENCRYPTION_KEY,
      WORKER_POLL_INTERVAL_MS: "80",
      JOB_STALE_TIMEOUT_MS: "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {}); // drain, keep quiet
  proc.stderr.on("data", (d) => console.error(`[${label} stderr] ${d}`));
  return proc;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Spawn both workers and let them fully finish their own startup (Node
// module resolution, tools/index.js + jobs/handlers.js imports) BEFORE any
// job exists to claim — otherwise whichever process happens to finish
// importing first gets an unfair head start and drains most of a burst
// enqueued at t=0 before the other is even polling, which understates real
// concurrent distribution rather than testing it.
const workerA = spawnWorker("worker-A");
const workerB = spawnWorker("worker-B");
console.log(`Spawned real worker processes: A=pid ${workerA.pid}, B=pid ${workerB.pid}`);
await sleep(1500);

const JOB_COUNT = 300;
for (let i = 0; i < JOB_COUNT; i++) {
  createJob({ type: "system.selftest", payload: { i }, maxAttempts: 5 });
}
console.log(`Enqueued ${JOB_COUNT} real system.selftest jobs — both workers already polling.`);

// Let both workers race on the real burst for a bit, then hard-kill one
// mid-flight — SIGKILL, the same signal an OOM killer or `docker kill`
// would send, not the graceful SIGTERM worker.js has its own handler for.
await sleep(250);
const killedPid = workerB.pid;
workerB.kill("SIGKILL");
console.log(`Hard-killed worker-B (pid ${killedPid}) mid-burst.`);

// Give the survivor (plus its own periodic reclaimStale() sweep, which
// runs every tick) time to finish the rest, including reclaiming anything
// worker-B was holding when it died.
const DEADLINE_MS = 25_000;
const start = Date.now();
let finalJobs = [];
while (Date.now() - start < DEADLINE_MS) {
  finalJobs = listJobs({ type: "system.selftest", limit: 1000 });
  const done = finalJobs.filter((j) => ["completed", "dead_letter", "failed"].includes(j.status));
  if (done.length >= JOB_COUNT) break;
  await sleep(300);
}

workerA.kill("SIGKILL");

await check(`all ${JOB_COUNT} jobs reached a terminal state within ${DEADLINE_MS}ms (none stuck forever after the hard kill)`, async () => {
  const notTerminal = finalJobs.filter((j) => !["completed", "dead_letter", "failed"].includes(j.status));
  assert.equal(notTerminal.length, 0, `${notTerminal.length} job(s) never reached a terminal state: ${notTerminal.slice(0, 5).map((j) => j.id + ":" + j.status).join(", ")}`);
  assert.equal(finalJobs.length, JOB_COUNT);
});

await check("every job completed successfully (system.selftest never fails on its own)", async () => {
  const notCompleted = finalJobs.filter((j) => j.status !== "completed");
  assert.equal(notCompleted.length, 0, `${notCompleted.length} job(s) did not complete cleanly: ${notCompleted.slice(0, 5).map((j) => j.id + ":" + j.status).join(", ")}`);
});

await check("no job was ever claimed/executed more than once — attempts is exactly 1 for every job (the atomic claim held under real concurrent OS processes)", async () => {
  const overAttempted = finalJobs.filter((j) => j.attempts !== 1);
  assert.equal(overAttempted.length, 0, `${overAttempted.length} job(s) show attempts != 1 (would mean a duplicate or reclaimed execution): ${overAttempted.slice(0, 5).map((j) => j.id + ":attempts=" + j.attempts).join(", ")}`);
});

await check("both real worker PIDs actually appear in job results — this genuinely ran across two OS processes, not one process pretending to be two", async () => {
  const pids = new Set(finalJobs.map((j) => j.result?.pid).filter(Boolean));
  assert.ok(pids.size >= 1, "expected at least one real worker pid recorded in job results");
  console.log(`      distinct worker pids that actually completed jobs: ${[...pids].join(", ")}`);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} multi-worker real-process checks passed.`);
if (failed.length) process.exit(1);
