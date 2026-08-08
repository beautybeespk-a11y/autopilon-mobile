import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import {
  createAgent, updateAgent, cloneAgent, setAgentStatus, deleteAgent,
  getVersionHistory, restoreVersion, getAgentHealth, getAgentStats,
  listAccessibleAgents, canAccessAgent, canManageAgent, agentScope,
} from "../orchestrator/agentManager.js";
import { listAgentMessages } from "../orchestrator/agentRouter.js";
import { hasPermission } from "../orchestrator/rbac.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  const agents = listAccessibleAgents(req.session.userId).map((a) => ({
    ...a, scope: agentScope(a), isOwner: a.userId === req.session.userId,
  }));
  res.json(agents);
});

router.get("/:id", (req, res) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
  if (!agent || !canAccessAgent(req.session.userId, agent)) return res.status(404).json({ error: "Agent not found" });
  const skills = db.prepare("SELECT s.* FROM skills s JOIN agent_skills a ON a.skillId = s.id WHERE a.agentId = ?").all(agent.id);
  res.json({ ...agent, skills, scope: agentScope(agent), isOwner: agent.userId === req.session.userId, canManage: canManageAgent(req.session.userId, agent) });
});

router.post("/", (req, res) => {
  try {
    const { orgId } = req.body || {};
    if (orgId && !hasPermission(orgId, req.session.userId, "agent_management")) {
      return res.status(403).json({ error: "You don't have permission to create agents for this organization." });
    }
    const agent = createAgent(req.session.userId, req.body || {});
    logActivity(db, req.session.userId, "agent_created", `Created agent "${agent.name}"`);
    res.json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/:id", (req, res) => {
  try {
    const { orgId } = req.body || {};
    if (orgId && !hasPermission(orgId, req.session.userId, "agent_management")) {
      return res.status(403).json({ error: "You don't have permission to share agents with this organization." });
    }
    const agent = updateAgent(req.session.userId, req.params.id, req.body || {});
    logActivity(db, req.session.userId, "agent_updated", `Updated agent "${agent.name}" (v${agent.version})`);
    res.json(agent);
  } catch (err) {
    res.status(err.message === "Agent not found." ? 404 : 400).json({ error: err.message });
  }
});

router.post("/:id/clone", (req, res) => {
  try {
    const agent = cloneAgent(req.session.userId, req.params.id, req.body?.name);
    logActivity(db, req.session.userId, "agent_cloned", `Cloned agent to "${agent.name}"`);
    res.json(agent);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/:id/activate", (req, res) => {
  try {
    const agent = setAgentStatus(req.session.userId, req.params.id, "active");
    logActivity(db, req.session.userId, "agent_activated", `Activated agent "${agent.name}"`);
    res.json(agent);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/:id/deactivate", (req, res) => {
  try {
    const agent = setAgentStatus(req.session.userId, req.params.id, "inactive");
    logActivity(db, req.session.userId, "agent_deactivated", `Deactivated agent "${agent.name}"`);
    res.json(agent);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get("/:id/versions", (req, res) => {
  try {
    res.json(getVersionHistory(req.session.userId, req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/:id/versions/:version/restore", (req, res) => {
  try {
    const agent = restoreVersion(req.session.userId, req.params.id, Number(req.params.version));
    logActivity(db, req.session.userId, "agent_restored", `Restored "${agent.name}" to version ${req.params.version}`);
    res.json(agent);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get("/:id/health", (req, res) => {
  try {
    res.json(getAgentHealth(req.session.userId, req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get("/:id/stats", (req, res) => {
  try {
    res.json(getAgentStats(req.session.userId, req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get("/:id/messages", (req, res) => {
  const agent = db.prepare("SELECT id FROM agents WHERE id = ? AND userId = ?").get(req.params.id, req.session.userId);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(listAgentMessages(req.session.userId, req.params.id));
});

router.delete("/:id", (req, res) => {
  try {
    deleteAgent(req.session.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

export default router;
