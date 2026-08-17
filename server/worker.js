// Standalone worker entrypoint (Phase 18 §8/§9/§31) — runs the exact same
// Job Manager processing loop (jobs/jobManager.js) the main API server runs
// inline, but with no Express app, no session middleware, no HTTP routes at
// all: this process's only job is claiming and running jobs from the
// shared jobs table.
//
// Real horizontal scaling: db.js opens app.sqlite in WAL mode, which
// natively supports multiple OS processes concurrently reading/writing the
// same file — so running N of these alongside the API server (which can
// keep or drop its own inline processor via RUN_INLINE_JOB_PROCESSOR, see
// below) is genuine multi-process job-processing distribution, not a
// simulation. It does NOT get you multi-MACHINE scaling (that needs every
// process on the same disk/volume, or a real distributed queue backend —
// see queueProvider.js's RedisQueueProvider and EXTERNAL_INFRASTRUCTURE.md
// for that path).
//
// Run with: node worker.js  (or `npm run worker` from server/)
import "dotenv/config";
import { validateEnv } from "./config/env.js";
validateEnv();

import "./tools/index.js"; // side-effect: registers all tools the AI orchestrator's job handlers may call
import "./jobs/handlers.js"; // side-effect: registers every job type this process can actually run
import { processJobsTick, initializeJobProcessor, stopJobProcessor, jobStats } from "./jobs/jobManager.js";
import { queueProviderStatus } from "./jobs/queueProvider.js";

const INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 3000;
const WORKER_ID = `worker-${process.pid}-${Date.now().toString(36)}`;

console.log(`[worker] ${WORKER_ID} starting — polling every ${INTERVAL_MS}ms`);
console.log(`[worker] queue provider: ${JSON.stringify(queueProviderStatus())}`);

initializeJobProcessor(INTERVAL_MS);

// Report a lightweight liveness/stats line periodically — this process has
// no HTTP server, so an operator's process manager (systemd/pm2/k8s) needs
// stdout, not a /health endpoint, to see this worker is alive and moving.
const statsInterval = setInterval(() => {
  console.log(`[worker] ${WORKER_ID} alive — jobs: ${JSON.stringify(jobStats())}`);
}, 60_000);
statsInterval.unref?.();

// Graceful shutdown (Phase 18 §31): stop claiming new work immediately,
// let any job already mid-handler finish naturally (it already has a
// reference to its own promise chain independent of the interval), then
// exit. No connection draining needed here — this process never accepts
// inbound connections.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${WORKER_ID} received ${signal}, stopping — no new jobs will be claimed`);
  stopJobProcessor();
  clearInterval(statsInterval);
  // One last drain of anything already claimed-but-not-yet-ticked is not
  // needed: claimNext() only runs inside processJobsTick(), which is not
  // re-entrant with itself here (setInterval firing every INTERVAL_MS is
  // already stopped), so there is nothing further to wait on.
  setTimeout(() => process.exit(0), 250);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
