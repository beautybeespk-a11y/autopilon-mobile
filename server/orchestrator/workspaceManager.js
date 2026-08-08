import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();

export function createWorkspace(orgId, { name, description, category }) {
  if (!name?.trim()) throw new Error("Workspace name is required.");
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    "INSERT INTO workspaces (id, orgId, name, description, category, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, orgId, name, description || "", category || "general", ts, ts);
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
}

export function listWorkspaces(orgId) {
  return db.prepare("SELECT * FROM workspaces WHERE orgId = ? ORDER BY name").all(orgId);
}

export function getWorkspace(workspaceId) {
  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId);
  if (!ws) throw new Error("Workspace not found.");
  return ws;
}

export function updateWorkspace(workspaceId, fields) {
  const { name, description, category } = fields;
  db.prepare(
    "UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description), category = COALESCE(?, category), updatedAt = ? WHERE id = ?"
  ).run(name, description, category, now(), workspaceId);
  return getWorkspace(workspaceId);
}

export function deleteWorkspace(workspaceId) {
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  return { deleted: true };
}

export function listWorkspaceMembers(workspaceId) {
  return db.prepare(
    `SELECT wm.id, wm.userId, wm.role, wm.createdAt, u.name AS userName, u.email AS userEmail, u.avatar AS userAvatar
     FROM workspace_members wm JOIN users u ON u.id = wm.userId
     WHERE wm.workspaceId = ? ORDER BY wm.createdAt`
  ).all(workspaceId);
}

// Only an existing organization member can be added to one of its
// workspaces — the caller (route) is responsible for that check, since it
// needs the org id, which this function doesn't have on its own.
export function addWorkspaceMember(workspaceId, userId, role) {
  const existing = db.prepare("SELECT id FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(workspaceId, userId);
  if (existing) throw new Error("This person is already in the workspace.");
  const id = cryptoRandom();
  db.prepare("INSERT INTO workspace_members (id, workspaceId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(id, workspaceId, userId, role || "member", now());
  return { id, userId, role: role || "member" };
}

export function removeWorkspaceMember(workspaceId, userId) {
  db.prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?").run(workspaceId, userId);
  return { removed: true };
}
