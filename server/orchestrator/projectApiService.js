// Project service for the Public API (Phase 17 §10). Every read/existence
// check here is filtered by orgId directly (via a workspace join, since
// projects belong to workspaces which belong to orgs) — the same
// org-boundary discipline as agentApiService.js/automationApiService.js,
// for the same reason: projectManager.js's own access checks are scoped to
// the CALLER'S broader personal org membership, not this specific API key's
// one org.
//
// Writes DO delegate to projectManager.js's existing create/update/delete
// functions (passing apiKey.userId) — once this file has confirmed the
// target belongs to req.orgId, projectManager's own role check (owner/admin
// required to manage a project) is exactly the right additional gate: an
// API key must never be able to do more than its own creator could do
// through the web UI, so that check is correct to keep, not bypass.
import db from "../db.js";
import { createProject, updateProject, deleteProject, addProjectItem, removeProjectItem, listProjectItems } from "./projectManager.js";

function toPublicShape(project) {
  if (!project) return null;
  return { id: project.id, workspaceId: project.workspaceId, name: project.name, description: project.description, status: project.status, createdAt: project.createdAt, updatedAt: project.updatedAt };
}

export function listOrgProjects(orgId, { limit, cursorClause }) {
  const rows = db.prepare(
    `SELECT p.* FROM projects p JOIN workspaces w ON w.id = p.workspaceId
     WHERE w.orgId = ? ${cursorClause.sql} ORDER BY p.createdAt DESC, p.id DESC LIMIT ?`
  ).all(orgId, ...cursorClause.params, limit + 1);
  return rows.map(toPublicShape);
}

export function getOrgProject(orgId, projectId) {
  const row = db.prepare(
    `SELECT p.* FROM projects p JOIN workspaces w ON w.id = p.workspaceId WHERE p.id = ? AND w.orgId = ?`
  ).get(projectId, orgId);
  return toPublicShape(row);
}

function requireWorkspaceInOrg(orgId, workspaceId) {
  const workspace = db.prepare("SELECT id FROM workspaces WHERE id = ? AND orgId = ?").get(workspaceId, orgId);
  if (!workspace) { const err = new Error("Workspace not found in this organization."); err.code = "NOT_FOUND"; throw err; }
}

export function createOrgProject(orgId, workspaceId, userId, { name, description }) {
  requireWorkspaceInOrg(orgId, workspaceId);
  return toPublicShape(createProject(userId, workspaceId, { name, description }));
}

export function updateOrgProject(orgId, projectId, userId, patch) {
  if (!getOrgProject(orgId, projectId)) { const err = new Error("Project not found."); err.code = "NOT_FOUND"; throw err; }
  return toPublicShape(updateProject(userId, projectId, patch));
}

export function archiveOrgProject(orgId, projectId, userId) {
  return updateOrgProject(orgId, projectId, userId, { status: "archived" });
}

export function listOrgProjectItems(orgId, projectId, userId) {
  if (!getOrgProject(orgId, projectId)) { const err = new Error("Project not found."); err.code = "NOT_FOUND"; throw err; }
  return listProjectItems(userId, projectId);
}

export function addOrgProjectItem(orgId, projectId, userId, itemType, itemId) {
  if (!getOrgProject(orgId, projectId)) { const err = new Error("Project not found."); err.code = "NOT_FOUND"; throw err; }
  return addProjectItem(userId, projectId, itemType, itemId);
}

export function removeOrgProjectItem(orgId, projectId, userId, itemType, itemId) {
  if (!getOrgProject(orgId, projectId)) { const err = new Error("Project not found."); err.code = "NOT_FOUND"; throw err; }
  return removeProjectItem(userId, projectId, itemType, itemId);
}
