import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { requireCapability } from "./featureGate.js";
import { apiRateLimit } from "./rateLimit.js";
import { idempotent } from "./idempotency.js";
import { apiError, apiErrorFromException } from "./errors.js";
import { listOrgIntegrations, listPublicActionsForProvider, executeIntegrationAction } from "../orchestrator/integrationApiService.js";

const router = Router();
router.use(requireApiKey, requireCapability("public_api_integrations"), apiRateLimit());

router.get("/", requireScope("integrations:read"), (req, res) => {
  res.json({ data: listOrgIntegrations(req.orgId) });
});

// Phase 17.1 §2 — a curated, explicitly-approved subset of the internal
// Tool Registry, never an arbitrary passthrough to a provider's own API.
// See orchestrator/integrationApiService.js's PUBLIC_INTEGRATION_ACTIONS
// for exactly which actions are exposed per provider.
router.get("/:provider/actions", requireScope("integrations:read"), (req, res) => {
  const actions = listPublicActionsForProvider(req.orgId, req.params.provider);
  if (actions === null) return apiError(res, 404, "RESOURCE_NOT_FOUND", "No connected integration with public actions was found for that provider.");
  res.json({ data: actions });
});

router.post("/:provider/actions/:actionName/execute", requireScope("integrations:execute"), idempotent(), async (req, res) => {
  const { agentId, parameters } = req.body || {};
  try {
    const result = await executeIntegrationAction(req.orgId, req.apiKey.id, req.apiKey.userId, req.params.provider, req.params.actionName, { agentId, parameters });
    res.json(result);
  } catch (err) {
    apiErrorFromException(res, err, "Integration action execution failed.");
  }
});

export default router;
