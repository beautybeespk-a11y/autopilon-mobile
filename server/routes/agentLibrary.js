import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { listTemplates, installTemplate, getTemplateSyncStatus, updateAgentFromTemplate } from "../orchestrator/agentLibrary.js";

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

router.get("/agents/:agentId/template-sync", (req, res) => {
  try {
    res.json(getTemplateSyncStatus(req.session.userId, req.params.agentId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/agents/:agentId/template-sync", (req, res) => {
  try {
    const agent = updateAgentFromTemplate(req.session.userId, req.params.agentId, Boolean(req.body?.force));
    logActivity(db, req.session.userId, "agent_updated", `Updated "${agent.name}" to the latest template instructions`);
    res.json(agent);
  } catch (err) {
    // CUSTOMIZED isn't a client error in the normal sense — it's a real
    // "confirm this overwrite" signal the UI should show as a warning
    // dialog with a force-retry option, not a generic failure toast.
    res.status(err.code === "CUSTOMIZED" ? 409 : 400).json({ error: err.message, code: err.code || null });
  }
});

export default router;
