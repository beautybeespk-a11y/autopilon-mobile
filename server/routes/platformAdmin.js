import { Router } from "express";
import db from "../db.js";
import { requireAuth, requirePlatformAdmin, logActivity } from "../middleware.js";
import { listPlans } from "../orchestrator/billing.js";
import { listAllOrganizations, updatePlan, listBillingLogs, grantManualTrial, grantCredit } from "../orchestrator/platformAdmin.js";
import {
  listPendingAssets, approveAsset, rejectAsset, suspendAsset,
  listOpenReports, resolveReport, createCategory, updateCategory, deleteCategory,
} from "../orchestrator/marketplaceModeration.js";
import { listJobs, getJob, jobStats, retryJob, cancelJob } from "../jobs/jobManager.js";
import { listFlags, getFlag, createFlag, updateFlag, disableFlag, deleteFlag, setOverride, removeOverride } from "../orchestrator/featureFlags.js";
import { maintenanceStatus, setMaintenanceMode } from "../orchestrator/maintenanceMode.js";

const router = Router();
router.use(requireAuth, requirePlatformAdmin);

// --- Job / queue operations ---

router.get("/queue/jobs", (req, res) => {
  const { type, status, limit } = req.query;
  res.json(listJobs({ type: type || undefined, status: status || undefined, limit: limit ? Number(limit) : undefined }));
});

router.get("/queue/stats", (req, res) => res.json(jobStats()));

router.get("/queue/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json(job);
});

router.post("/queue/jobs/:id/retry", (req, res) => {
  const ok = retryJob(req.params.id);
  if (!ok) return res.status(400).json({ error: "This job isn't in a retryable state (must be failed or dead_letter)." });
  logActivity(db, req.session.userId, "admin_job_retried", `Retried job ${req.params.id}`, { req });
  res.json({ ok: true, job: getJob(req.params.id) });
});

router.post("/queue/jobs/:id/cancel", (req, res) => {
  const ok = cancelJob(req.params.id);
  if (!ok) return res.status(400).json({ error: "This job can't be cancelled (already finished)." });
  logActivity(db, req.session.userId, "admin_job_cancelled", `Cancelled job ${req.params.id}`, { req });
  res.json({ ok: true, job: getJob(req.params.id) });
});

// --- Feature flags ---

router.get("/feature-flags", (req, res) => res.json(listFlags()));

router.post("/feature-flags", (req, res) => {
  try {
    const flag = createFlag(req.body || {});
    logActivity(db, req.session.userId, "feature_flag_created", `Created feature flag "${flag.key}"`, { req });
    res.json(flag);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch("/feature-flags/:key", (req, res) => {
  try {
    const flag = updateFlag(req.params.key, req.body || {});
    logActivity(db, req.session.userId, "feature_flag_updated", `Updated feature flag "${req.params.key}": ${JSON.stringify(req.body)}`, { req });
    res.json(flag);
  } catch (err) { res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message }); }
});

// A dedicated emergency-disable action — one click, no payload to get
// wrong, separate from the general PATCH so it reads unambiguously in the
// audit log as "someone hit the kill switch" rather than an ordinary edit.
router.post("/feature-flags/:key/disable", (req, res) => {
  try {
    const flag = disableFlag(req.params.key);
    logActivity(db, req.session.userId, "feature_flag_disabled", `Emergency-disabled feature flag "${req.params.key}"`, { req });
    res.json(flag);
  } catch (err) { res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message }); }
});

router.delete("/feature-flags/:key", (req, res) => {
  deleteFlag(req.params.key);
  logActivity(db, req.session.userId, "feature_flag_deleted", `Deleted feature flag "${req.params.key}"`, { req });
  res.json({ ok: true });
});

router.post("/feature-flags/:key/overrides", (req, res) => {
  const { scopeType, scopeId, enabled } = req.body || {};
  if (!scopeType || !scopeId || enabled === undefined) return res.status(400).json({ error: "scopeType, scopeId, and enabled are required." });
  try {
    const flag = setOverride(req.params.key, scopeType, scopeId, enabled);
    logActivity(db, req.session.userId, "feature_flag_override_set", `Set ${scopeType}:${scopeId} override on "${req.params.key}" to ${enabled}`, { req });
    res.json(flag);
  } catch (err) { res.status(err.code === "NOT_FOUND" ? 404 : 400).json({ error: err.message }); }
});

router.delete("/feature-flags/:key/overrides/:scopeType/:scopeId", (req, res) => {
  const flag = removeOverride(req.params.key, req.params.scopeType, req.params.scopeId);
  logActivity(db, req.session.userId, "feature_flag_override_removed", `Removed ${req.params.scopeType}:${req.params.scopeId} override on "${req.params.key}"`, { req });
  res.json(flag);
});

// --- Maintenance mode ---

router.get("/maintenance", (req, res) => res.json(maintenanceStatus()));

router.post("/maintenance", (req, res) => {
  const { enabled, message, readOnly } = req.body || {};
  const status = setMaintenanceMode({ enabled, message, readOnly });
  logActivity(db, req.session.userId, "maintenance_mode_changed", `Maintenance mode ${status.enabled ? "ENABLED" : "disabled"}${status.readOnly ? " (read-only)" : ""}`, { req });
  res.json(status);
});

router.get("/organizations", (req, res) => {
  res.json(listAllOrganizations({ limit: req.query.limit, offset: req.query.offset }));
});

router.get("/plans", (req, res) => {
  res.json(listPlans());
});

router.patch("/plans/:id", (req, res) => {
  try {
    const plan = updatePlan(req.params.id, req.body || {});
    logActivity(db, req.session.userId, "plan_updated", `Updated plan "${plan.name}"`, { req });
    res.json(plan);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/billing-logs", (req, res) => {
  res.json(listBillingLogs(Number(req.query.limit) || 100));
});

router.post("/organizations/:orgId/grant-trial", (req, res) => {
  const { planId, days } = req.body || {};
  if (!planId || !days) return res.status(400).json({ error: "planId and days are required." });
  try {
    const result = grantManualTrial(req.session.userId, req.params.orgId, planId, Number(days));
    logActivity(db, req.session.userId, "manual_credit_granted", `Granted ${days}-day ${planId} trial to org ${req.params.orgId}`, { orgId: req.params.orgId, req });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/organizations/:orgId/adjustment-note", (req, res) => {
  const { note } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: "note is required." });
  logActivity(db, req.session.userId, "support_adjustment", note, { orgId: req.params.orgId, req });
  res.json({ ok: true });
});

router.post("/organizations/:orgId/credits", async (req, res) => {
  const { amountCents, reason } = req.body || {};
  if (!amountCents || Number(amountCents) <= 0) return res.status(400).json({ error: "amountCents must be a positive number." });
  const result = await grantCredit(req.session.userId, req.params.orgId, Number(amountCents), reason);
  logActivity(db, req.session.userId, "manual_credit_granted", `Granted $${(amountCents / 100).toFixed(2)} credit${reason ? `: ${reason}` : ""}`, { orgId: req.params.orgId, req });
  res.json(result);
});

// --- Marketplace moderation ---
router.get("/marketplace/pending", (req, res) => res.json(listPendingAssets()));

router.post("/marketplace/assets/:id/approve", (req, res) => {
  const result = approveAsset(req.params.id);
  logActivity(db, req.session.userId, "marketplace_asset_moderated", "Approved a pending marketplace asset");
  res.json(result);
});

router.post("/marketplace/assets/:id/reject", (req, res) => {
  const result = rejectAsset(req.params.id, req.body?.reason);
  logActivity(db, req.session.userId, "marketplace_asset_moderated", `Rejected a marketplace asset: ${req.body?.reason || ""}`);
  res.json(result);
});

router.post("/marketplace/assets/:id/suspend", (req, res) => {
  const result = suspendAsset(req.params.id, req.body?.reason);
  logActivity(db, req.session.userId, "marketplace_asset_moderated", `Suspended a marketplace asset: ${req.body?.reason || ""}`);
  res.json(result);
});

router.get("/marketplace/reports", (req, res) => res.json(listOpenReports()));

router.post("/marketplace/reports/:id/resolve", (req, res) => {
  const { action } = req.body || {};
  try { res.json(resolveReport(req.session.userId, req.params.id, action || "resolved")); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/marketplace/categories", (req, res) => {
  const { name, description } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "name is required." });
  res.json(createCategory(name, description));
});

router.patch("/marketplace/categories/:id", (req, res) => {
  try { res.json(updateCategory(req.params.id, req.body || {})); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.delete("/marketplace/categories/:id", (req, res) => {
  try { res.json(deleteCategory(req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

export default router;
