import { Router } from "express";
import db from "../db.js";
import { requireAuth } from "../middleware.js";
import { getPlatformAgentSummary, listAgentsWithStats } from "../orchestrator/agentManager.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const uid = req.session.userId;
  const one = (sql) => db.prepare(sql).get(uid).c;
  const summary = getPlatformAgentSummary(uid);
  res.json({
    activeAgents: summary.activeAgents,
    availableSkills: db.prepare("SELECT COUNT(*) c FROM skills WHERE status = 'available'").get().c,
    connectedIntegrations: one("SELECT COUNT(*) c FROM integrations WHERE userId = ? AND status = 'connected'"),
    runningAutomations: summary.activeAutomations,
    recentActivity: db.prepare("SELECT * FROM activity_logs WHERE userId = ? ORDER BY createdAt DESC LIMIT 6").all(uid),
    // Phase 8 additions — the Agent Dashboard page uses these; the older
    // summary cards above are left untouched for backward compatibility.
    agentSummary: summary,
  });
});

// Dedicated endpoint for the Agent Dashboard's per-agent performance table.
router.get("/agents", (req, res) => {
  res.json({ summary: getPlatformAgentSummary(req.session.userId), agents: listAgentsWithStats(req.session.userId) });
});

export default router;
