import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getMembership } from "./rbac.js";
import { getWorkspace } from "./workspaceManager.js";

const now = () => new Date().toISOString();

// A project belongs to a workspace, so access follows the workspace's own
// access rule: any active member of the parent organization, narrowed to
// this specific workspace's members if it has any (same pattern already
// used for Shared Agents/Automations workspace scoping).
export function canAccessProject(userId, project) {
  const workspace = getWorkspace(project.workspaceId);
  const orgMembership = getMembership(workspace.orgId, userId);
  if (!orgMembership) return false;
  const workspaceMemberCount = db.prepare("SELECT COUNT(*) c FROM workspace_members WHERE workspaceId = ?").get(workspace.id).c;
  if (workspaceMemberCount === 0) return true; // no members assigned yet — treat as org-wide visible
  return Boolean(db.prepare("SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(workspace.id, userId));
}

export function canManageProject(userId, project) {
  const workspace = getWorkspace(project.workspaceId);
  const membership = getMembership(workspace.orgId, userId);
  return Boolean(membership && ["owner", "admin"].includes(membership.role));
}

export function createProject(userId, workspaceId, { name, description }) {
  const workspace = getWorkspace(workspaceId);
  const membership = getMembership(workspace.orgId, userId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new Error("Only an organization owner or admin can create projects.");
  }
  if (!name?.trim()) throw new Error("Project name is required.");
  const id = cryptoRandom();
  const ts = now();
  db.prepare("INSERT INTO projects (id, workspaceId, name, description, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'active', ?, ?)")
    .run(id, workspaceId, name, description || "", ts, ts);
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

export function listProjects(userId, workspaceId) {
  const workspace = getWorkspace(workspaceId);
  if (!getMembership(workspace.orgId, userId)) throw new Error("You're not a member of this workspace's organization.");
  return db.prepare("SELECT * FROM projects WHERE workspaceId = ? ORDER BY updatedAt DESC").all(workspaceId);
}

export function getProject(userId, id) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!project || !canAccessProject(userId, project)) throw new Error("Project not found.");
  return project;
}

export function updateProject(userId, id, fields) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!project || !canManageProject(userId, project)) throw new Error("Project not found.");
  const { name, description, status } = fields;
  db.prepare("UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), status = COALESCE(?, status), updatedAt = ? WHERE id = ?")
    .run(name, description, status, now(), id);
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

export function deleteProject(userId, id) {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!project || !canManageProject(userId, project)) throw new Error("Project not found.");
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return { deleted: true };
}

const ITEM_TABLES = {
  task: { table: "tasks", fields: "id, title AS name, status" },
  agent: { table: "agents", fields: "id, name, status" },
  knowledge: { table: "knowledge_items", fields: "id, title AS name, category" },
  automation: { table: "automations", fields: "id, name, status" },
  conversation: { table: "conversations", fields: "id, title AS name, updatedAt" },
};

export function addProjectItem(userId, projectId, itemType, itemId) {
  const project = getProject(userId, projectId); // also enforces access
  if (!ITEM_TABLES[itemType]) throw new Error(`Unknown item type "${itemType}".`);
  const id = cryptoRandom();
  db.prepare("INSERT OR IGNORE INTO project_items (id, projectId, itemType, itemId, addedAt) VALUES (?, ?, ?, ?, ?)")
    .run(id, project.id, itemType, itemId, now());
  return { added: true };
}

export function removeProjectItem(userId, projectId, itemType, itemId) {
  getProject(userId, projectId); // enforces access
  db.prepare("DELETE FROM project_items WHERE projectId = ? AND itemType = ? AND itemId = ?").run(projectId, itemType, itemId);
  return { removed: true };
}

// Resolves each linked item's real row from its own table — a project's
// item list is just references, never a copy of the underlying data.
export function listProjectItems(userId, projectId) {
  getProject(userId, projectId); // enforces access
  const links = db.prepare("SELECT * FROM project_items WHERE projectId = ? ORDER BY addedAt DESC").all(projectId);
  const byType = {};
  for (const link of links) (byType[link.itemType] ||= []).push(link.itemId);

  const resolved = [];
  for (const [itemType, ids] of Object.entries(byType)) {
    const config = ITEM_TABLES[itemType];
    if (!config || !ids.length) continue;
    const rows = db.prepare(`SELECT ${config.fields} FROM ${config.table} WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
    for (const row of rows) resolved.push({ itemType, ...row });
  }
  return resolved;
}
