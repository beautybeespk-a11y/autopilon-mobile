import db from "../db.js";
import { getMembership } from "./rbac.js";

// Mirrors knowledgeAccess.js's readableKnowledgeClause exactly — same
// private|workspace|organization visibility convention, same reasoning.
// "shared" isn't in this SQL fragment because it depends on a join against
// file_permissions, not a column comparison; see readableFileIds() below
// for the version that also folds in explicit per-user grants.
export function readableFilesClause(userId) {
  const orgIds = db.prepare("SELECT orgId FROM organization_members WHERE userId = ? AND status = 'active'").all(userId).map((r) => r.orgId);
  const workspaceIds = db.prepare("SELECT workspaceId FROM workspace_members WHERE userId = ?").all(userId).map((r) => r.workspaceId);

  const clauses = ["ownerId = ?"];
  const params = [userId];

  if (orgIds.length) {
    clauses.push(`(visibility = 'organization' AND orgId IN (${orgIds.map(() => "?").join(",")}))`);
    params.push(...orgIds);
  }
  if (workspaceIds.length) {
    clauses.push(`(visibility = 'workspace' AND workspaceId IN (${workspaceIds.map(() => "?").join(",")}))`);
    params.push(...workspaceIds);
  }
  // 'shared' files: readable via an explicit file_permissions grant.
  clauses.push(
    `id IN (SELECT fileId FROM file_permissions WHERE subjectType = 'user' AND subjectId = ?)`
  );
  params.push(userId);

  return { sql: `(${clauses.join(" OR ")})`, params };
}

function explicitGrantActions(fileId, userId) {
  return db.prepare("SELECT permission FROM file_permissions WHERE fileId = ? AND subjectType = 'user' AND subjectId = ?")
    .all(fileId, userId)
    .map((r) => r.permission);
}

// The single function every route/tool goes through before touching a file.
// action: 'view' | 'download' | 'edit' | 'share' | 'delete' | 'manage'.
// Scope-based access (visibility = workspace/organization) only ever grants
// view/download — editing, sharing, deleting, or managing permissions
// always requires either ownership or an explicit grant (or, for
// delete/manage on an organization-scoped file, being that org's
// owner/admin — same override knowledgeAccess.js's canDeleteKnowledgeItem
// already applies to knowledge items).
export function canAccessFile(userId, file, action) {
  if (!file || !userId) return false;
  if (file.ownerId === userId) return true;

  const granted = explicitGrantActions(file.id, userId);
  if (granted.includes("manage")) return true;
  if (granted.includes(action)) return true;

  if (action === "view" || action === "download") {
    if (file.visibility === "organization" && file.orgId && getMembership(file.orgId, userId)) return true;
    if (file.visibility === "workspace" && file.workspaceId) {
      const inWorkspace = db.prepare("SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(file.workspaceId, userId);
      if (inWorkspace) return true;
    }
  }

  if ((action === "delete" || action === "manage") && file.orgId) {
    const membership = getMembership(file.orgId, userId);
    if (membership && ["owner", "admin"].includes(membership.role)) return true;
  }

  return false;
}

export const canViewFile = (userId, file) => canAccessFile(userId, file, "view");
export const canDownloadFile = (userId, file) => canAccessFile(userId, file, "download");
export const canEditFile = (userId, file) => canAccessFile(userId, file, "edit");
export const canShareFile = (userId, file) => canAccessFile(userId, file, "share");
export const canDeleteFile = (userId, file) => canAccessFile(userId, file, "delete");
export const canManageFile = (userId, file) => canAccessFile(userId, file, "manage");

// Same visibility model as files, reused verbatim for folders (a folder has
// no owner-only "shared" grant list of its own in this pass — sharing a
// folder means sharing the files inside it individually).
export function canAccessFolder(userId, folder, action) {
  if (!folder || !userId) return false;
  if (folder.ownerId === userId) return true;
  if (action === "view") {
    if (folder.visibility === "organization" && folder.orgId && getMembership(folder.orgId, userId)) return true;
    if (folder.visibility === "workspace" && folder.workspaceId) {
      const inWorkspace = db.prepare("SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(folder.workspaceId, userId);
      if (inWorkspace) return true;
    }
  }
  if (folder.orgId) {
    const membership = getMembership(folder.orgId, userId);
    if (membership && ["owner", "admin"].includes(membership.role)) return true;
  }
  return false;
}
