import { Router } from "express";
import db from "../db.js";
import { requireAuth } from "../middleware.js";
import { getMembership } from "../orchestrator/rbac.js";

const router = Router();
router.use(requireAuth);

// An organization's full audit trail is itself sensitive — restricted to
// owner/admin, not just "any member," unlike most other org read endpoints.
router.get("/:orgId/audit-logs", (req, res) => {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can view its audit log." });
  }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { action, userId } = req.query;
  const clauses = ["orgId = ?"];
  const params = [req.params.orgId];
  if (action) { clauses.push("action = ?"); params.push(action); }
  if (userId) { clauses.push("userId = ?"); params.push(userId); }

  const rows = db.prepare(
    `SELECT al.*, u.name AS userName, u.email AS userEmail FROM activity_logs al
     LEFT JOIN users u ON u.id = al.userId
     WHERE ${clauses.join(" AND ")} ORDER BY al.createdAt DESC LIMIT ?`
  ).all(...params, limit);
  res.json(rows);
});

export default router;
