import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { canAccessFolder } from "./filePermissions.js";

const now = () => new Date().toISOString();

export function getFolder(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM folders WHERE id = ?").get(id);
}

export function requireFolderAccess(userId, folderId, action) {
  const folder = getFolder(folderId);
  if (!folder) {
    const err = new Error("Folder not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!canAccessFolder(userId, folder, action)) {
    const err = new Error("You don't have permission to do that.");
    err.code = "FORBIDDEN";
    throw err;
  }
  return folder;
}

export function createFolder({ userId, orgId, workspaceId, projectId, name, parentFolderId, visibility }) {
  if (parentFolderId) requireFolderAccess(userId, parentFolderId, "view");
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO folders (id, orgId, workspaceId, projectId, ownerId, name, parentFolderId, visibility, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId || null, workspaceId || null, projectId || null, userId, name, parentFolderId || null, visibility || "private", ts, ts);
  return getFolder(id);
}

// A folder tree is scoped to exactly one of: an organization, a workspace,
// a project, or "my personal folders" — same simplification listFiles()
// below makes. Mixing scopes into one merged tree would need a much more
// complex permission-aware traversal for little real benefit at this stage.
export function listFolders({ userId, parentFolderId = null, orgId, workspaceId, projectId, trashed = false }) {
  let sql = `SELECT * FROM folders WHERE trashedAt IS ${trashed ? "NOT NULL" : "NULL"}`;
  const params = [];
  if (orgId) { sql += " AND orgId = ?"; params.push(orgId); }
  else if (workspaceId) { sql += " AND workspaceId = ?"; params.push(workspaceId); }
  else if (projectId) { sql += " AND projectId = ?"; params.push(projectId); }
  else { sql += " AND ownerId = ? AND orgId IS NULL AND workspaceId IS NULL AND projectId IS NULL"; params.push(userId); }

  if (parentFolderId === null) sql += " AND parentFolderId IS NULL";
  else { sql += " AND parentFolderId = ?"; params.push(parentFolderId); }

  sql += " ORDER BY name ASC";
  return db.prepare(sql).all(...params).filter((f) => canAccessFolder(userId, f, "view"));
}

export function folderBreadcrumb(folderId) {
  const crumbs = [];
  let current = getFolder(folderId);
  while (current) {
    crumbs.unshift({ id: current.id, name: current.name });
    current = current.parentFolderId ? getFolder(current.parentFolderId) : null;
  }
  return crumbs;
}

export function renameFolder(userId, folderId, name) {
  requireFolderAccess(userId, folderId, "manage");
  db.prepare("UPDATE folders SET name = ?, updatedAt = ? WHERE id = ?").run(name, now(), folderId);
  return getFolder(folderId);
}

export function moveFolder(userId, folderId, newParentFolderId) {
  requireFolderAccess(userId, folderId, "manage");
  if (newParentFolderId) {
    requireFolderAccess(userId, newParentFolderId, "view");
    let cursor = getFolder(newParentFolderId);
    while (cursor) {
      if (cursor.id === folderId) {
        const err = new Error("Can't move a folder into itself or one of its own subfolders.");
        err.code = "INVALID";
        throw err;
      }
      cursor = cursor.parentFolderId ? getFolder(cursor.parentFolderId) : null;
    }
  }
  db.prepare("UPDATE folders SET parentFolderId = ?, updatedAt = ? WHERE id = ?").run(newParentFolderId || null, now(), folderId);
  return getFolder(folderId);
}

export function trashFolder(userId, folderId) {
  requireFolderAccess(userId, folderId, "manage");
  db.prepare("UPDATE folders SET trashedAt = ?, updatedAt = ? WHERE id = ?").run(now(), now(), folderId);
}

export function restoreFolder(userId, folderId) {
  requireFolderAccess(userId, folderId, "manage");
  db.prepare("UPDATE folders SET trashedAt = NULL, updatedAt = ? WHERE id = ?").run(now(), folderId);
}

// Walks the whole subtree and permanently removes everything — every
// version's storage bytes, then the DB rows. permanentlyDeleteFileFn is
// injected by the caller (fileService.js's permanentlyDeleteFile) rather
// than imported directly, to avoid a circular import between the two
// services.
export async function permanentlyDeleteFolder(userId, folderId, permanentlyDeleteFileFn) {
  requireFolderAccess(userId, folderId, "manage");
  const childFolders = db.prepare("SELECT id FROM folders WHERE parentFolderId = ?").all(folderId);
  for (const child of childFolders) {
    await permanentlyDeleteFolder(userId, child.id, permanentlyDeleteFileFn);
  }
  const files = db.prepare("SELECT id FROM files WHERE folderId = ?").all(folderId);
  for (const file of files) {
    await permanentlyDeleteFileFn(userId, file.id);
  }
  db.prepare("DELETE FROM folders WHERE id = ?").run(folderId);
}
