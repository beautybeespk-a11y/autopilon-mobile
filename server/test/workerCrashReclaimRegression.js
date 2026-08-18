// Phase 19 §12/§13/§36 — worker-crash job reclaim regression. Found via
// this phase's required controlled-failure testing: a worker that crashes
// (SIGKILL, OOM, power loss — not a graceful SIGTERM, which stops claiming
// new work but lets an in-flight handler finish) mid-job left that job at
// status='running' forever, with nothing in the codebase ever transitioning
// it back out. Real production code (jobs/jobManager.js's processJobsTick(),
// jobs/queueProvider.js's InProcessQueueProvider.reclaimStale()) — this test
// simulates the crash deterministically (claim a job, then never call
// complete()/fail() on it, backdating startedAt instead of waiting out a
// real 10-minute timeout) rather than actually killing a process, which
// Phase 19.2's separate real-multi-process test covers for the distribution
// side of this same subsystem.
//
//   node test/workerCrashReclaimRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/worker-crash-reclaim-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-reclaim-test";
process.env.JOB_STALE_TIMEOUT_MS = "200"; // short, so the test doesn't wait 10 real minutes

const db = (await import("../db.js")).default;
const { createJob, getJob, processJobsTick, registerJobHandler } = await import("../jobs/jobManager.js");
const { syncProvider } = await import("../jobs/queueProvider.js");

registerJobHandler("test.reclaim_probe", async (payload) => {
  return { ok: true, echoedAt: new Date().toISOString(), payload };
});

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

function backdateStartedAt(jobId, msAgo) {
  const ts = new Date(Date.now() - msAgo).toISOString();
  db.prepare("UPDATE jobs SET startedAt = ? WHERE id = ?").run(ts, jobId);
}

await check("a job claimed and abandoned (simulated crash) longer ago than the stale timeout is reclaimed back to 'queued', not left stuck forever", async () => {
  const job = createJob({ type: "test.reclaim_probe", payload: { n: 1 }, maxAttempts: 3 });
  const claimed = syncProvider().claimNext(["test.reclaim_probe"]);
  assert.equal(claimed.id, job.id);
  assert.equal(getJob(job.id).status, "running");
  backdateStartedAt(job.id, 5000); // 5s ago, well past the 200ms test timeout
  await processJobsTick(0); // batchSize 0: only run the reclaim sweep, claim nothing new
  const after = getJob(job.id);
  assert.equal(after.status, "queued", `expected reclaimed job to be 'queued' again, got '${after.status}'`);
  assert.ok(after.error && after.error.includes("Reclaimed"), "reclaimed job's error message should say it was reclaimed, not look like an ordinary handler failure");
});

await check("a job claimed within the stale timeout window is NOT reclaimed — an actively-running job must not be yanked out from under its real worker", async () => {
  const job = createJob({ type: "test.reclaim_probe", payload: { n: 2 }, maxAttempts: 3 });
  syncProvider().claimNext(["test.reclaim_probe"]);
  // no backdate — startedAt is "now", well inside the 200ms window
  await processJobsTick(0);
  const after = getJob(job.id);
  assert.equal(after.status, "running", `expected a genuinely in-flight job to stay 'running', got '${after.status}'`);
});

await check("a reclaimed job whose attempts already reached maxAttempts goes to 'dead_letter', not an infinite reclaim loop", async () => {
  const job = createJob({ type: "test.reclaim_probe", payload: { n: 3 }, maxAttempts: 1 });
  syncProvider().claimNext(["test.reclaim_probe"]); // attempts now 1 === maxAttempts
  backdateStartedAt(job.id, 5000);
  await processJobsTick(0);
  const after = getJob(job.id);
  assert.equal(after.status, "dead_letter", `expected exhausted-attempts reclaim to dead-letter, got '${after.status}'`);
});

await check("end-to-end: a reclaimed job is picked back up by a normal tick afterward and completes successfully — the fix doesn't just relabel it, it genuinely un-sticks it", async () => {
  const job = createJob({ type: "test.reclaim_probe", payload: { n: 4 }, maxAttempts: 3 });
  syncProvider().claimNext(["test.reclaim_probe"]);
  backdateStartedAt(job.id, 5000);
  await processJobsTick(0); // reclaim: running -> queued
  assert.equal(getJob(job.id).status, "queued");
  // reclaimStale() applies the same exponential backoff fail() would (a
  // few real seconds here) — advance past it directly rather than
  // sleeping in a test, since backoff timing itself is already covered
  // elsewhere; this check is only about "does it actually get reprocessed".
  db.prepare("UPDATE jobs SET nextAttemptAt = NULL WHERE id = ?").run(job.id);
  await processJobsTick(5); // a normal tick: claims it and actually runs test.reclaim_probe's real handler
  const after = getJob(job.id);
  assert.equal(after.status, "completed", `expected the reclaimed job to actually complete on the next real tick, got '${after.status}'`);
  assert.equal(after.result.payload.n, 4);
});

await check("no false-positive reclaim of a job that isn't 'running' at all (e.g. already completed) — reclaimStale() must not touch finished work", async () => {
  const job = createJob({ type: "test.reclaim_probe", payload: { n: 5 }, maxAttempts: 3 });
  syncProvider().claimNext(["test.reclaim_probe"]);
  syncProvider().complete(job.id, { done: true });
  backdateStartedAt(job.id, 5000); // completedAt is what should matter now, not this
  await processJobsTick(0);
  const after = getJob(job.id);
  assert.equal(after.status, "completed", `a completed job must never be reclaimed, got '${after.status}'`);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} worker-crash reclaim checks passed.`);
if (failed.length) process.exit(1);
