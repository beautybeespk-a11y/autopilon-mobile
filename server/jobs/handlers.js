// Built-in job handlers. Importing this file (once, from index.js) runs the
// registerJobHandler() calls as a side effect — same convention as
// tools/index.js registering every tool.
import { registerJobHandler } from "./jobManager.js";
import { executeAgentRunFromJob } from "../orchestrator/agentApiService.js";

// A trivial, always-succeeds job used by /health/queue to prove the queue
// is actually enqueuing AND processing, not just that the HTTP server is up.
registerJobHandler("system.selftest", async (payload, { reportProgress }) => {
  reportProgress(50, "self-test running");
  return { ok: true, echoedAt: new Date().toISOString(), payload };
});

// Async Public API agent execution (Phase 17 §7) — executeAgentRunFromJob()
// calls the exact same runAgentTurn() the synchronous /execute route uses;
// this handler exists only to let the Job Manager drive it (retry on
// failure, dead-letter after maxAttempts) instead of holding the original
// HTTP request open. The api_agent_runs row (not the job's own result
// field) is what GET /v1/runs/:id actually reads back.
registerJobHandler("public_api.agent_run", async (payload) => {
  return executeAgentRunFromJob(payload);
});
