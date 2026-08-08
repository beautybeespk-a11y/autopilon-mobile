import { Router } from "express";
import db from "../db.js";
import { requireAuth, requirePlatformAdmin, logActivity } from "../middleware.js";
import { listPlans } from "../orchestrator/billing.js";
import { listAllOrganizations, updatePlan, listBillingLogs, grantManualTrial, grantCredit } from "../orchestrator/platformAdmin.js";
import {
  listPendingAssets, approveAsset, rejectAsset, suspendAsset,
  listOpenReports, resolveReport, createCategory, updateCategory, deleteCategory,
} from "../orchestrator/marketplaceModeration.js";

const router = Router();
router.use(requireAuth, requirePlatformAdmin);

router.get("/organizations", (req, res) => {
  res.json(listAllOrganizations());
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
