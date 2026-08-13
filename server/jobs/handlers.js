// Built-in job handlers. Importing this file (once, from index.js) runs the
// registerJobHandler() calls as a side effect — same convention as
// tools/index.js registering every tool.
import { registerJobHandler } from "./jobManager.js";

// A trivial, always-succeeds job used by /health/queue to prove the queue
// is actually enqueuing AND processing, not just that the HTTP server is up.
registerJobHandler("system.selftest", async (payload, { reportProgress }) => {
  reportProgress(50, "self-test running");
  return { ok: true, echoedAt: new Date().toISOString(), payload };
});
