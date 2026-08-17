// Task service for the Public API (Phase 17 §9). The internal tasks
// feature (routes/tasks.js) predates any org concept — just a personal
// to-do list scoped to userId, with no update/complete/archive routes at
// all. Rather than bolt org-awareness onto that minimal internal route (or
// leave the Public API unable to see any tasks at all, since it has no org
// dimension to filter on), this is a small, separate, org-scoped service
// over the SAME table — additive, not a rewrite of the internal feature,
// which is untouched and keeps working exactly as it did.
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

const now = () => new Date().toISOString();
const VALID_STATUSES = ["todo", "in_progress", "completed", "archived"];

function toPublicShape(row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, description: row.description, status: row.status,
    priority: row.priority, dueDate: row.dueDate, assignedToUserId: row.assignedToUserId,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export function listOrgTasks(orgId, { limit, cursorClause }) {
  const rows = db.prepare(
    `SELECT * FROM tasks WHERE orgId = ? ${cursorClause.sql} ORDER BY createdAt DESC, id DESC LIMIT ?`
  ).all(orgId, ...cursorClause.params, limit + 1);
  return rows.map(toPublicShape);
}

export function getOrgTask(orgId, taskId) {
  return toPublicShape(db.prepare("SELECT * FROM tasks WHERE id = ? AND orgId = ?").get(taskId, orgId));
}

export function createOrgTask(orgId, userId, { title, description, priority, dueDate }) {
  if (!title?.trim()) { const err = new Error("title is required."); err.code = "INVALID"; throw err; }
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, userId, orgId, title, description, status, priority, dueDate, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`
  ).run(id, userId, orgId, title.trim(), description || "", priority || "medium", dueDate || null, ts, ts);
  return getOrgTask(orgId, id);
}

export function updateOrgTask(orgId, taskId, patch) {
  const existing = db.prepare("SELECT id FROM tasks WHERE id = ? AND orgId = ?").get(taskId, orgId);
  if (!existing) { const err = new Error("Task not found."); err.code = "NOT_FOUND"; throw err; }
  if (patch.status !== undefined && !VALID_STATUSES.includes(patch.status)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(", ")}`); err.code = "INVALID"; throw err;
  }
  const sets = [];
  const params = [];
  for (const field of ["title", "description", "status", "priority", "dueDate"]) {
    if (patch[field] !== undefined) { sets.push(`${field} = ?`); params.push(patch[field]); }
  }
  if (!sets.length) return getOrgTask(orgId, taskId);
  sets.push("updatedAt = ?"); params.push(now());
  params.push(taskId, orgId);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND orgId = ?`).run(...params);
  return getOrgTask(orgId, taskId);
}

export function completeOrgTask(orgId, taskId) {
  return updateOrgTask(orgId, taskId, { status: "completed" });
}

export function archiveOrgTask(orgId, taskId) {
  return updateOrgTask(orgId, taskId, { status: "archived" });
}
