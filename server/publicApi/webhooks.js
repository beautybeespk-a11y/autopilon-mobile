import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { requireCapability } from "./featureGate.js";
import { apiRateLimit } from "./rateLimit.js";
import { apiError, apiErrorFromException } from "./errors.js";
import {
  createWebhook, listWebhooks, getWebhook, getWebhookSecret, updateWebhook, deleteWebhook, sendTestEvent, WEBHOOK_EVENT_TYPES,
} from "../orchestrator/developerWebhookService.js";
import { listWebhookDeliveries } from "../orchestrator/webhookEvents.js";

const router = Router();
router.use(requireApiKey, requireCapability("public_api_webhooks"), apiRateLimit());

router.get("/event-types", requireScope("webhooks:manage"), (req, res) => res.json({ data: WEBHOOK_EVENT_TYPES }));

router.get("/", requireScope("webhooks:manage"), (req, res) => {
  res.json({ data: listWebhooks(req.orgId) });
});

router.get("/:id", requireScope("webhooks:manage"), (req, res) => {
  const webhook = getWebhook(req.orgId, req.params.id);
  if (!webhook) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested webhook was not found.");
  res.json(webhook);
});

router.post("/", requireScope("webhooks:manage"), async (req, res) => {
  try {
    res.status(201).json(await createWebhook(req.orgId, req.apiKey.userId, req.body || {}));
  } catch (err) {
    apiErrorFromException(res, err, "Could not create webhook.");
  }
});

router.get("/:id/secret", requireScope("webhooks:manage"), (req, res) => {
  try {
    res.json(getWebhookSecret(req.orgId, req.params.id));
  } catch (err) {
    apiErrorFromException(res, err, "Could not retrieve webhook secret.");
  }
});

router.patch("/:id", requireScope("webhooks:manage"), async (req, res) => {
  try {
    res.json(await updateWebhook(req.orgId, req.params.id, req.body || {}));
  } catch (err) {
    apiErrorFromException(res, err, "Could not update webhook.");
  }
});

router.delete("/:id", requireScope("webhooks:manage"), (req, res) => {
  try {
    res.json(deleteWebhook(req.orgId, req.params.id));
  } catch (err) {
    apiErrorFromException(res, err, "Could not delete webhook.");
  }
});

router.post("/:id/test", requireScope("webhooks:manage"), async (req, res) => {
  try {
    res.json(await sendTestEvent(req.orgId, req.params.id));
  } catch (err) {
    apiErrorFromException(res, err, "Test delivery failed.");
  }
});

router.get("/:id/deliveries", requireScope("webhooks:manage"), (req, res) => {
  const webhook = getWebhook(req.orgId, req.params.id);
  if (!webhook) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested webhook was not found.");
  res.json({ data: listWebhookDeliveries(req.orgId, req.params.id, Number(req.query.limit) || 50) });
});

export default router;
