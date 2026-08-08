import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import {
  createProject, listProjects, getProject, updateProject, deleteProject,
  addProjectItem, removeProjectItem, listProjectItems,
} from "../orchestrator/projectManager.js";

const router = Router();
router.use(requireAuth);

router.get("/workspaces/:workspaceId/projects", (req, res) => {
  try { res.json(listProjects(req.session.userId, req.params.workspaceId)); }
  catch (err) { res.status(403).json({ error: err.message }); }
});

router.post("/workspaces/:workspaceId/projects", (req, res) => {
  try {
    const project = createProject(req.session.userId, req.params.workspaceId, req.body || {});
    logActivity(db, req.session.userId, "project_created", `Created project "${project.name}"`);
    res.json(project);
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

router.get("/projects/:id", (req, res) => {
  try { res.json(getProject(req.session.userId, req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.patch("/projects/:id", (req, res) => {
  try { res.json(updateProject(req.session.userId, req.params.id, req.body || {})); }
  catch (err) { res.status(403).json({ error: err.message }); }
});

router.delete("/projects/:id", (req, res) => {
  try { res.json(deleteProject(req.session.userId, req.params.id)); }
  catch (err) { res.status(403).json({ error: err.message }); }
});

router.get("/projects/:id/items", (req, res) => {
  try { res.json(listProjectItems(req.session.userId, req.params.id)); }
  catch (err) { res.status(403).json({ error: err.message }); }
});

router.post("/projects/:id/items", (req, res) => {
  const { itemType, itemId } = req.body || {};
  if (!itemType || !itemId) return res.status(400).json({ error: "itemType and itemId are required." });
  try { res.json(addProjectItem(req.session.userId, req.params.id, itemType, itemId)); }
  catch (err) { res.status(403).json({ error: err.message }); }
});

router.delete("/projects/:id/items/:itemType/:itemId", (req, res) => {
  try { res.json(removeProjectItem(req.session.userId, req.params.id, req.params.itemType, req.params.itemId)); }
  catch (err) { res.status(403).json({ error: err.message }); }
});

export default router;
