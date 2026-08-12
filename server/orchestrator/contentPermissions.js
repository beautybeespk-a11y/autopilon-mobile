import db from "../db.js";
import { getMembership } from "./rbac.js";

// Same private|workspace|organization model as filePermissions.js, applied
// to content_assets. There's no separate explicit-per-user-grant table for
// content (unlike files' file_permissions) in this pass — a media asset's
// underlying file already has the full grant/share-link system via its
// fileId, so sharing a specific image/video with one person means sharing
// that file directly in the File Manager; workspace/organization visibility
// or Project assignment cover the common content-sharing cases here.
export function readableContentClause(userId) {
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
  return { sql: `(${clauses.join(" OR ")})`, params };
}

export function canAccessContent(userId, asset, action) {
  if (!asset || !userId) return false;
  if (asset.ownerId === userId) return true;

  if (action === "view") {
    if (asset.visibility === "organization" && asset.orgId && getMembership(asset.orgId, userId)) return true;
    if (asset.visibility === "workspace" && asset.workspaceId) {
      const inWorkspace = db.prepare("SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(asset.workspaceId, userId);
      if (inWorkspace) return true;
    }
  }
  if ((action === "delete" || action === "manage") && asset.orgId) {
    const membership = getMembership(asset.orgId, userId);
    if (membership && ["owner", "admin"].includes(membership.role)) return true;
  }
  return false;
}

export const canViewContent = (userId, asset) => canAccessContent(userId, asset, "view");
// No dedicated "edit" tier in this pass — owner, or (for org-scoped
// content) an org owner/admin, same bar as delete/manage.
export const canEditContent = (userId, asset) => canAccessContent(userId, asset, "manage");
export const canDeleteContent = (userId, asset) => canAccessContent(userId, asset, "delete");
