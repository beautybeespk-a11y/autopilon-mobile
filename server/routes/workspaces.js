import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import {
  createWorkspace, listWorkspaces, getWorkspace, updateWorkspace, deleteWorkspace,
  listWorkspaceMembers, addWorkspaceMember, removeWorkspaceMember,
} from "../orchestrator/workspaceManager.js";
import { getMembership } from "../orchestrator/rbac.js";

const router = Router();
router.use(requireAuth);

// A workspace is only reachable through an organization the user actually
// belongs to — this loads the workspace and checks that in one place so
// every route below doesn't have to repeat it.
function loadWorkspaceIfMember(req, res, next) {
  try {
    const ws = getWorkspace(req.params.id);
    const membership = getMembership(ws.orgId, req.session.userId);
    if (!membership) return res.status(403).json({ error: "You're not a member of this workspace's organization." });
    req.workspace = ws;
    req.orgMembership = membership;
    next();
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}

router.get("/organizations/:orgId/workspaces", (req, res) => {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership) return res.status(403).json({ error: "You're not a member of this organization." });
  res.json(listWorkspaces(req.params.orgId));
});

router.post("/organizations/:orgId/workspaces", (req, res) => {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can create workspaces." });
  }
  try {
    const ws = createWorkspace(req.params.orgId, req.body || {});
    logActivity(db, req.session.userId, "workspace_created", `Created workspace "${ws.name}"`);
    res.json(ws);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/workspaces/:id", loadWorkspaceIfMember, (req, res) => res.json(req.workspace));

router.patch("/workspaces/:id", loadWorkspaceIfMember, (req, res) => {
  if (!["owner", "admin"].includes(req.orgMembership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can edit workspaces." });
  }
  const ws = updateWorkspace(req.params.id, req.body || {});
  logActivity(db, req.session.userId, "workspace_updated", `Updated workspace "${ws.name}"`);
  res.json(ws);
});

router.delete("/workspaces/:id", loadWorkspaceIfMember, (req, res) => {
  if (!["owner", "admin"].includes(req.orgMembership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can delete workspaces." });
  }
  deleteWorkspace(req.params.id);
  logActivity(db, req.session.userId, "workspace_deleted", "Deleted a workspace");
  res.json({ deleted: true });
});

router.get("/workspaces/:id/members", loadWorkspaceIfMember, (req, res) => {
  res.json(listWorkspaceMembers(req.params.id));
});

router.post("/workspaces/:id/members", loadWorkspaceIfMember, (req, res) => {
  if (!["owner", "admin", "manager"].includes(req.orgMembership.role)) {
    return res.status(403).json({ error: "You don't have permission to add workspace members." });
  }
  const { userId, role } = req.body || {};
  if (!getMembership(req.workspace.orgId, userId)) {
    return res.status(400).json({ error: "That user isn't a member of this organization." });
  }
  try {
    res.json(addWorkspaceMember(req.params.id, userId, role));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/workspaces/:id/members/:userId", loadWorkspaceIfMember, (req, res) => {
  if (!["owner", "admin", "manager"].includes(req.orgMembership.role)) {
    return res.status(403).json({ error: "You don't have permission to remove workspace members." });
  }
  removeWorkspaceMember(req.params.id, req.params.userId);
  res.json({ removed: true });
});

export default router;
