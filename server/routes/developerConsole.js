// Developer Console backend (Phase 17 §24) — session-authenticated
// (browser login, same as every other internal route), NOT the Bearer-key
// Public API. This is deliberate: managing API keys/webhooks has to work
// BEFORE a developer has any API key at all (there's no key to create the
// first key with), so it goes through the same auth every other org
// settings page already uses. The actual business logic
// (apiKeyService.js, developerWebhookService.js, webhookEvents.js,
// apiUsageService.js) is the exact same code the Public API's own Bearer-
// token routes call — only the auth/permission layer differs here.
import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { getMembership } from "../orchestrator/rbac.js";
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, API_SCOPES } from "../orchestrator/apiKeyService.js";
import {
  createWebhook, listWebhooks, getWebhook, getWebhookSecret, updateWebhook, deleteWebhook, sendTestEvent, WEBHOOK_EVENT_TYPES,
} from "../orchestrator/developerWebhookService.js";
import { listWebhookDeliveries } from "../orchestrator/webhookEvents.js";
import { getApiUsageDashboard, listApiRequestLogs } from "../orchestrator/apiUsageService.js";

const router = Router();
router.use(requireAuth);

function requireOwnerOrAdmin(req, res, next) {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can manage the developer console." });
  }
  next();
}

router.get("/:orgId/developer/scopes", requireOwnerOrAdmin, (req, res) => res.json({ data: API_SCOPES }));

// --- API keys ---
router.get("/:orgId/developer/api-keys", requireOwnerOrAdmin, (req, res) => {
  res.json({ data: listApiKeys(req.params.orgId) });
});

router.post("/:orgId/developer/api-keys", requireOwnerOrAdmin, (req, res) => {
  try {
    const key = createApiKey(req.params.orgId, req.session.userId, req.body || {});
    logActivity(db, req.session.userId, "api_key_created", `Created developer API key "${key.name}"`, { orgId: req.params.orgId, req });
    res.status(201).json(key);
  } catch (err) {
    res.status(err.code === "INVALID" ? 400 : 500).json({ error: err.message });
  }
});

router.post("/:orgId/developer/api-keys/:id/revoke", requireOwnerOrAdmin, (req, res) => {
  try {
    const key = revokeApiKey(req.params.orgId, req.params.id);
    logActivity(db, req.session.userId, "api_key_revoked", `Revoked developer API key "${key.name}"`, { orgId: req.params.orgId, req });
    res.json(key);
  } catch (err) {
    res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
  }
});

router.post("/:orgId/developer/api-keys/:id/rotate", requireOwnerOrAdmin, (req, res) => {
  try {
    const key = rotateApiKey(req.params.orgId, req.params.id);
    logActivity(db, req.session.userId, "api_key_rotated", `Rotated developer API key "${key.name}"`, { orgId: req.params.orgId, req });
    res.json(key);
  } catch (err) {
    res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
  }
});

// --- Webhooks ---
router.get("/:orgId/developer/webhooks/event-types", requireOwnerOrAdmin, (req, res) => res.json({ data: WEBHOOK_EVENT_TYPES }));

router.get("/:orgId/developer/webhooks", requireOwnerOrAdmin, (req, res) => {
  res.json({ data: listWebhooks(req.params.orgId) });
});

router.post("/:orgId/developer/webhooks", requireOwnerOrAdmin, async (req, res) => {
  try {
    const webhook = await createWebhook(req.params.orgId, req.session.userId, req.body || {});
    logActivity(db, req.session.userId, "webhook_created", `Created developer webhook for ${webhook.url}`, { orgId: req.params.orgId, req });
    res.status(201).json(webhook);
  } catch (err) {
    res.status(err.code === "INVALID" ? 400 : 500).json({ error: err.message });
  }
});

router.get("/:orgId/developer/webhooks/:id/secret", requireOwnerOrAdmin, (req, res) => {
  try {
    res.json(getWebhookSecret(req.params.orgId, req.params.id));
  } catch (err) {
    res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
  }
});

router.patch("/:orgId/developer/webhooks/:id", requireOwnerOrAdmin, async (req, res) => {
  try {
    res.json(await updateWebhook(req.params.orgId, req.params.id, req.body || {}));
  } catch (err) {
    res.status(err.code === "NOT_FOUND" ? 404 : err.code === "INVALID" ? 400 : 500).json({ error: err.message });
  }
});

router.delete("/:orgId/developer/webhooks/:id", requireOwnerOrAdmin, (req, res) => {
  try {
    res.json(deleteWebhook(req.params.orgId, req.params.id));
    logActivity(db, req.session.userId, "webhook_deleted", "Deleted a developer webhook", { orgId: req.params.orgId, req });
  } catch (err) {
    res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
  }
});

router.post("/:orgId/developer/webhooks/:id/test", requireOwnerOrAdmin, async (req, res) => {
  try {
    res.json(await sendTestEvent(req.params.orgId, req.params.id));
  } catch (err) {
    res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
  }
});

router.get("/:orgId/developer/webhooks/:id/deliveries", requireOwnerOrAdmin, (req, res) => {
  if (!getWebhook(req.params.orgId, req.params.id)) return res.status(404).json({ error: "Webhook not found." });
  res.json({ data: listWebhookDeliveries(req.params.orgId, req.params.id, Number(req.query.limit) || 50) });
});

// --- Usage dashboard ---
router.get("/:orgId/developer/usage", requireOwnerOrAdmin, (req, res) => {
  res.json(getApiUsageDashboard(req.params.orgId, { sinceDays: Number(req.query.sinceDays) || 30 }));
});

router.get("/:orgId/developer/logs", requireOwnerOrAdmin, (req, res) => {
  res.json({ data: listApiRequestLogs(req.params.orgId, { limit: Number(req.query.limit) || 50, apiKeyId: req.query.apiKeyId }) });
});

export default router;
