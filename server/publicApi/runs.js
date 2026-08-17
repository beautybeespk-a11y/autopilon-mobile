// GET /v1/runs/:id (Phase 17 §7) — a top-level resource since a run isn't
// only reachable through its agent (a client that only has the run id from
// an earlier /execute response shouldn't need to also know the agent id).
import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { apiRateLimit } from "./rateLimit.js";
import { apiError } from "./errors.js";
import { getRun } from "../orchestrator/agentApiService.js";

const router = Router();
router.use(requireApiKey, apiRateLimit());

router.get("/:id", requireScope("agents:read"), (req, res) => {
  const run = getRun(req.orgId, req.params.id);
  if (!run) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested run was not found.");
  res.json(run);
});

export default router;
