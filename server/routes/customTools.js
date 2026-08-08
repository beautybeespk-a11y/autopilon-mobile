import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import {
  createCustomTool, listMyCustomTools, updateCustomTool, setCustomToolStatus, deleteCustomTool, callCustomToolWebhook,
} from "../orchestrator/customTools.js";

const router = Router();
router.use(requireAuth);

router.get("/tools", (req, res) => res.json(listMyCustomTools(req.session.userId)));

router.post("/tools", (req, res) => {
  try {
    const tool = createCustomTool(req.session.userId, req.body || {});
    logActivity(db, req.session.userId, "custom_tool_created", `Created custom tool "${tool.name}"`);
    res.json(tool);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/tools/:id", (req, res) => {
  try { res.json(updateCustomTool(req.session.userId, req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/tools/:id/publish", (req, res) => {
  try {
    const tool = setCustomToolStatus(req.session.userId, req.params.id, "published");
    logActivity(db, req.session.userId, "custom_tool_published", `Published custom tool "${tool.name}"`);
    res.json(tool);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/tools/:id/disable", (req, res) => {
  try { res.json(setCustomToolStatus(req.session.userId, req.params.id, "disabled")); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete("/tools/:id", (req, res) => {
  try { res.json(deleteCustomTool(req.session.userId, req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Lets a developer test their own webhook directly (without going through
// an actual agent conversation) — same execution function real tool calls
// use, so a successful test genuinely means the real thing will work too.
router.post("/tools/:id/test", async (req, res) => {
  const tools = listMyCustomTools(req.session.userId);
  const tool = tools.find((t) => t.id === req.params.id);
  if (!tool) return res.status(404).json({ error: "Tool not found." });
  try {
    const result = await callCustomToolWebhook(tool, req.body?.parameters || {}, { userId: req.session.userId, agentId: null });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

export default router;
