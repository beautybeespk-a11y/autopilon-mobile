import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { requireCapability } from "./featureGate.js";
import { apiRateLimit } from "./rateLimit.js";
import { apiError, apiErrorFromException } from "./errors.js";
import { parsePagination, paginate, cursorWhereClause } from "./pagination.js";
import { listOrgAutomations, getOrgAutomation, triggerOrgAutomation, listOrgAutomationRuns, getOrgAutomationRun } from "../orchestrator/automationApiService.js";

const router = Router();
router.use(requireApiKey, requireCapability("public_api_automations"), apiRateLimit());

router.get("/", requireScope("automations:read"), (req, res) => {
  const { limit, cursor } = parsePagination(req);
  const rows = listOrgAutomations(req.orgId, { limit, cursorClause: cursorWhereClause(cursor) });
  const { data, pagination } = paginate(rows, limit);
  res.json({ data, pagination });
});

router.get("/:id", requireScope("automations:read"), (req, res) => {
  const automation = getOrgAutomation(req.orgId, req.params.id);
  if (!automation) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested automation was not found.");
  res.json(automation);
});

router.post("/:id/run", requireScope("automations:execute"), async (req, res) => {
  try {
    const result = await triggerOrgAutomation(req.orgId, req.params.id, { userId: req.apiKey.userId, variables: req.body?.variables });
    res.json(result);
  } catch (err) {
    apiErrorFromException(res, err, "Automation run failed.");
  }
});

router.get("/:id/runs", requireScope("automations:read"), (req, res) => {
  try {
    const { limit, cursor } = parsePagination(req);
    const rows = listOrgAutomationRuns(req.orgId, req.params.id, { limit, cursorClause: cursorWhereClause(cursor) });
    const { data, pagination } = paginate(rows, limit);
    res.json({ data, pagination });
  } catch (err) {
    apiErrorFromException(res, err, "Could not list runs.");
  }
});

router.get("/runs/:runId", requireScope("automations:read"), (req, res) => {
  const run = getOrgAutomationRun(req.orgId, req.params.runId);
  if (!run) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested run was not found.");
  res.json(run);
});

export default router;
