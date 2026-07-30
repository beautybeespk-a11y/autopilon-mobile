import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { listTemplates, installTemplate } from "../orchestrator/agentLibrary.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json(listTemplates());
});

router.post("/:templateId/install", (req, res) => {
  try {
    const agent = installTemplate(req.session.userId, req.params.templateId, req.body?.name);
    logActivity(db, req.session.userId, "agent_created", `Installed "${agent.name}" from the Agent Library`);
    res.json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
