import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import * as engine from "../automation/engine.js";
import { runWorkflow, runScheduledAutomation } from "../automation/runner.js";
import { registerSchedule, unregisterSchedule } from "../automation/scheduler.js";
import { recentEvents, eventSourceStats } from "../automation/triggers.js";
import { queueHealth } from "../automation/eventQueue.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) => res.json(engine.listAutomations(req.session.userId)));

router.get("/dashboard", (req, res) => res.json(engine.dashboardMetrics(req.session.userId)));

router.get("/events", (req, res) => res.json(recentEvents(req.session.userId)));

router.get("/events/stats", (req, res) => res.json(eventSourceStats(req.session.userId)));

router.get("/queue-health", (req, res) => res.json(queueHealth(req.session.userId)));

router.get("/templates", (req, res) => {
  const templates = db.prepare("SELECT * FROM workflow_templates ORDER BY name ASC").all();
  res.json(templates.map((t) => ({ ...t, triggerConfig: JSON.parse(t.triggerConfig || "{}"), steps: JSON.parse(t.steps || "[]") })));
});

router.post("/from-template/:templateId", (req, res) => {
  const template = db.prepare("SELECT * FROM workflow_templates WHERE id = ?").get(req.params.templateId);
  if (!template) return res.status(404).json({ error: "Template not found" });
  // Default to the user's first agent so a cloned template has working
  // skills/tools out of the box — same fallback used elsewhere (Chat page,
  // the builder's own default). Without an agent, every action step fails
  // permission checks immediately, regardless of what it's trying to do.
  const defaultAgent = db.prepare("SELECT id FROM agents WHERE userId = ? ORDER BY createdAt ASC LIMIT 1").get(req.session.userId);
  const id = engine.createAutomation(req.session.userId, {
    name: template.name,
    description: template.description,
    triggerType: template.triggerType,
    triggerConfig: JSON.parse(template.triggerConfig || "{}"),
    steps: JSON.parse(template.steps || "[]"),
    agentId: defaultAgent?.id || null,
    status: "draft", // clone lands as a draft — review before activating, per spec
  });
  logActivity(db, req.session.userId, "automation_created", `Created "${template.name}" from a template`);
  res.json({ id });
});

router.get("/:id", (req, res) => {
  const automation = engine.getAutomation(req.session.userId, req.params.id);
  if (!automation) return res.status(404).json({ error: "Automation not found" });
  res.json(automation);
});

router.post("/", (req, res) => {
  const { name, description, triggerType, triggerConfig, variables, agentId, orgId, workspaceId, steps } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Name is required." });
  if (!triggerType) return res.status(400).json({ error: "A trigger type is required." });
  try {
    const id = engine.createAutomation(req.session.userId, { name, description, triggerType, triggerConfig, variables, agentId, orgId, workspaceId, steps, status: "draft" });
    logActivity(db, req.session.userId, "automation_created", `Created automation "${name}"`);
    res.json({ id });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.patch("/:id", (req, res) => {
  try {
    const ok = engine.updateAutomation(req.session.userId, req.params.id, req.body || {});
    if (!ok) return res.status(404).json({ error: "Automation not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.get("/:id/versions", (req, res) => {
  const versions = engine.getAutomationVersions(req.session.userId, req.params.id);
  if (!versions) return res.status(404).json({ error: "Automation not found" });
  res.json(versions);
});

router.post("/:id/activate", (req, res) => {
  const ok = engine.setAutomationStatus(req.session.userId, req.params.id, "active");
  if (!ok) return res.status(404).json({ error: "Automation not found" });
  const automation = db.prepare("SELECT * FROM automations WHERE id = ?").get(req.params.id);
  if (automation.triggerType === "schedule") registerSchedule(automation, runScheduledAutomation);
  res.json({ ok: true });
});

router.post("/:id/pause", (req, res) => {
  const ok = engine.setAutomationStatus(req.session.userId, req.params.id, "paused");
  if (!ok) return res.status(404).json({ error: "Automation not found" });
  unregisterSchedule(req.params.id);
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  unregisterSchedule(req.params.id);
  const ok = engine.deleteAutomation(req.session.userId, req.params.id);
  if (!ok) return res.status(404).json({ error: "Automation not found" });
  res.json({ ok: true });
});

// Manual trigger — "Run now".
router.post("/:id/run", async (req, res) => {
  const automation = engine.getAutomation(req.session.userId, req.params.id);
  if (!automation) return res.status(404).json({ error: "Automation not found" });
  const result = await runWorkflow(automation.id, { userId: req.session.userId, triggerSource: "manual", initialVariables: req.body?.variables || {} });
  res.json(result);
});

router.get("/:id/runs", (req, res) => res.json(engine.listRuns(req.session.userId, req.params.id)));

router.get("/runs/:runId", (req, res) => {
  const detail = engine.getRunDetail(req.session.userId, req.params.runId);
  if (!detail) return res.status(404).json({ error: "Run not found" });
  res.json(detail);
});

export default router;
