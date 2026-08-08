import { Router } from "express";
import { requireAuth } from "../middleware.js";
import { getMembership } from "../orchestrator/rbac.js";
import { getOrgDashboard, getOrgAnalytics } from "../orchestrator/enterpriseAnalytics.js";

const router = Router();
router.use(requireAuth);

function requireOwnerOrAdmin(req, res, next) {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can view this." });
  }
  next();
}

router.get("/:orgId/dashboard", requireOwnerOrAdmin, (req, res) => {
  res.json(getOrgDashboard(req.params.orgId));
});

router.get("/:orgId/analytics", requireOwnerOrAdmin, (req, res) => {
  res.json(getOrgAnalytics(req.params.orgId, { sinceDays: Number(req.query.sinceDays) || 30 }));
});

export default router;
