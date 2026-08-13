import { Router } from "express";
import db from "../db.js";
import { requireAuth, requirePlatformAdmin, logActivity } from "../middleware.js";
import { getMembership } from "../orchestrator/rbac.js";
import { listPlans, getBillingDashboard, setPlan, setBillingMode } from "../orchestrator/billing.js";
import { saveApiKey, listApiKeys, deleteApiKey } from "../orchestrator/apiKeys.js";
import { getCostBreakdown } from "../orchestrator/costEngine.js";
import { getSpendLimits, setSpendLimits, getSpendStatus } from "../orchestrator/costControls.js";
import { stripeStatus, createCheckoutSession, createPortalSession, cancelSubscription, resumeSubscription } from "../orchestrator/stripeService.js";
import { getCreditBalance, listCredits } from "../orchestrator/platformAdmin.js";

const router = Router();
router.use(requireAuth);

function requireOwnerOrAdmin(req, res, next) {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can manage billing." });
  }
  next();
}

// Public catalog — any authenticated user can see what plans exist and
// compare limits, same as any pricing page.
router.get("/plans", (req, res) => res.json(listPlans()));

router.get("/organizations/:orgId/billing", requireOwnerOrAdmin, (req, res) => {
  res.json(getBillingDashboard(req.params.orgId));
});

router.get("/organizations/:orgId/cost", requireOwnerOrAdmin, (req, res) => {
  res.json(getCostBreakdown(req.params.orgId, { sinceDays: Number(req.query.sinceDays) || 30 }));
});

router.get("/organizations/:orgId/spend-limits", requireOwnerOrAdmin, (req, res) => {
  res.json(getSpendStatus(req.params.orgId));
});

router.patch("/organizations/:orgId/spend-limits", requireOwnerOrAdmin, (req, res) => {
  const limits = setSpendLimits(req.params.orgId, req.body || {});
  logActivity(db, req.session.userId, "spend_limits_updated", `Updated AI spend limits for org ${req.params.orgId}`, { orgId: req.params.orgId, req });
  res.json(limits);
});

router.get("/stripe/status", (req, res) => res.json(stripeStatus()));

// Direct plan assignment is now platform-admin only — now that real Stripe
// checkout exists, an org owner setting their own plan here would be a free
// self-upgrade bypassing payment entirely. Org owners use checkout/portal
// below instead; direct assignment stays available for admin/support use.
router.post("/organizations/:orgId/billing/plan", requirePlatformAdmin, (req, res) => {
  try {
    const result = setPlan(req.params.orgId, req.body?.planId);
    logActivity(db, req.session.userId, "plan_changed", `Changed plan to "${req.body?.planId}"`, { orgId: req.params.orgId, req });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/organizations/:orgId/billing/checkout", requireOwnerOrAdmin, async (req, res) => {
  const { planId } = req.body || {};
  if (!planId) return res.status(400).json({ error: "planId is required." });
  try {
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const url = await createCheckoutSession(
      req.params.orgId, planId,
      `${base}/app/organizations/${req.params.orgId}?checkout=success`,
      `${base}/app/organizations/${req.params.orgId}?checkout=canceled`
    );
    res.json({ url });
  } catch (err) {
    res.status(err.code === "STRIPE_NOT_CONFIGURED" ? 503 : 400).json({ error: err.message });
  }
});

router.post("/organizations/:orgId/billing/portal", requireOwnerOrAdmin, async (req, res) => {
  try {
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const url = await createPortalSession(req.params.orgId, `${base}/app/organizations/${req.params.orgId}`);
    res.json({ url });
  } catch (err) {
    res.status(err.code === "STRIPE_NOT_CONFIGURED" ? 503 : 400).json({ error: err.message });
  }
});

router.post("/organizations/:orgId/billing/cancel", requireOwnerOrAdmin, async (req, res) => {
  try {
    const result = await cancelSubscription(req.params.orgId, req.body?.atPeriodEnd !== false);
    logActivity(db, req.session.userId, "subscription_canceled", "Canceled the subscription (via Stripe)", { orgId: req.params.orgId, req });
    res.json(result);
  } catch (err) {
    res.status(err.code === "STRIPE_NOT_CONFIGURED" ? 503 : 400).json({ error: err.message });
  }
});

router.post("/organizations/:orgId/billing/resume", requireOwnerOrAdmin, async (req, res) => {
  try {
    const result = await resumeSubscription(req.params.orgId);
    logActivity(db, req.session.userId, "subscription_resumed", "Resumed a scheduled cancellation (via Stripe)", { orgId: req.params.orgId, req });
    res.json(result);
  } catch (err) {
    res.status(err.code === "STRIPE_NOT_CONFIGURED" ? 503 : 400).json({ error: err.message });
  }
});

router.get("/organizations/:orgId/credits", requireOwnerOrAdmin, (req, res) => {
  res.json({ balanceCents: getCreditBalance(req.params.orgId), history: listCredits(req.params.orgId) });
});

router.get("/organizations/:orgId/invoices", requireOwnerOrAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM invoices WHERE orgId = ? ORDER BY createdAt DESC LIMIT 50").all(req.params.orgId));
});

router.post("/organizations/:orgId/billing/mode", requireOwnerOrAdmin, (req, res) => {
  try {
    const result = setBillingMode(req.params.orgId, req.body?.billingMode);
    logActivity(db, req.session.userId, "billing_mode_changed", `Set billing mode to "${req.body?.billingMode}"`, { orgId: req.params.orgId, req });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- BYOK ---
router.get("/organizations/:orgId/api-keys", requireOwnerOrAdmin, (req, res) => {
  try { res.json(listApiKeys(req.params.orgId)); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

router.post("/organizations/:orgId/api-keys", requireOwnerOrAdmin, (req, res) => {
  const { provider, apiKey } = req.body || {};
  if (!provider || !apiKey) return res.status(400).json({ error: "provider and apiKey are required." });
  try {
    saveApiKey(req.params.orgId, provider, apiKey);
    logActivity(db, req.session.userId, "api_key_saved", `Saved a ${provider} API key for the organization`, { orgId: req.params.orgId, req });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.code === "ENCRYPTION_NOT_CONFIGURED" ? 503 : 400).json({ error: err.message });
  }
});

router.delete("/organizations/:orgId/api-keys/:provider", requireOwnerOrAdmin, (req, res) => {
  deleteApiKey(req.params.orgId, req.params.provider);
  logActivity(db, req.session.userId, "api_key_deleted", `Removed a ${req.params.provider} API key`, { orgId: req.params.orgId, req });
  res.json({ ok: true });
});

export default router;
