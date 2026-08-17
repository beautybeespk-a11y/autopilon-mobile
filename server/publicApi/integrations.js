import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { requireCapability } from "./featureGate.js";
import { apiRateLimit } from "./rateLimit.js";
import { listOrgIntegrations } from "../orchestrator/integrationApiService.js";

const router = Router();
router.use(requireApiKey, requireCapability("public_api_integrations"), apiRateLimit());

router.get("/", requireScope("integrations:read"), (req, res) => {
  res.json({ data: listOrgIntegrations(req.orgId) });
});

export default router;
