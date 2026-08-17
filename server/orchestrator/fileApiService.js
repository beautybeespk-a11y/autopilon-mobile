// File service for the Public API (Phase 17 §11). List uses a direct
// org-scoped query (createdAt-ordered, to match the shared cursor
// pagination scheme every other v1 list endpoint uses — listFiles()'s own
// ordering is different and has its own filter-builder not worth
// retrofitting). Single-file get/upload/delete reuse fileService.js's
// existing functions, each preceded by an explicit `file.orgId === orgId`
// check — getFile()/requireFileAccess() have no orgId parameter at all, so
// without that check a file belonging to a DIFFERENT org the API key
// creator also happens to have personal access to would be reachable, the
// same cross-tenant gap class fixed everywhere else this phase.
import db from "../db.js";
import { getFile, uploadFile, downloadFile, trashFile } from "./fileService.js";
import { createShare } from "./fileShare.js";

function toPublicShape(file) {
  if (!file) return null;
  return {
    id: file.id, filename: file.filename, mimeType: file.mimeType, extension: file.extension,
    sizeBytes: file.sizeBytes, folderId: file.folderId, visibility: file.visibility,
    status: file.status, processingStatus: file.processingStatus,
    createdAt: file.createdAt, updatedAt: file.updatedAt,
  };
}

export function listOrgFiles(orgId, { limit, cursorClause, folderId }) {
  const clauses = ["orgId = ?", "status = 'active'"];
  const params = [orgId];
  if (folderId !== undefined) {
    clauses.push(folderId ? "folderId = ?" : "folderId IS NULL");
    if (folderId) params.push(folderId);
  }
  const rows = db.prepare(
    `SELECT * FROM files WHERE ${clauses.join(" AND ")} ${cursorClause.sql} ORDER BY createdAt DESC, id DESC LIMIT ?`
  ).all(...params, ...cursorClause.params, limit + 1);
  return rows.map(toPublicShape);
}

export function getOrgFile(orgId, fileId) {
  const file = getFile(fileId);
  if (!file || file.orgId !== orgId) return null;
  return toPublicShape(file);
}

export async function uploadOrgFile(orgId, userId, { buffer, filename, mimeType, folderId, visibility, tags }) {
  if (folderId) {
    const folder = db.prepare("SELECT orgId FROM folders WHERE id = ?").get(folderId);
    if (!folder || folder.orgId !== orgId) { const err = new Error("Folder not found in this organization."); err.code = "NOT_FOUND"; throw err; }
  }
  const file = await uploadFile({ userId, orgId, folderId, buffer, originalFilename: filename, mimeType, visibility, tags });
  return toPublicShape(file);
}

export async function downloadOrgFile(orgId, userId, fileId) {
  const file = getFile(fileId);
  if (!file || file.orgId !== orgId) { const err = new Error("File not found."); err.code = "NOT_FOUND"; throw err; }
  return downloadFile(userId, fileId, { orgId });
}

export function deleteOrgFile(orgId, userId, fileId) {
  const file = getFile(fileId);
  if (!file || file.orgId !== orgId) { const err = new Error("File not found."); err.code = "NOT_FOUND"; throw err; }
  return trashFile(userId, fileId);
}

// A signed, time-limited download link — reuses the exact same file_shares
// mechanism (Phase 14) the web app's own "Share" button already uses,
// rather than a second signed-URL scheme. Always expires (default 1 hour)
// even though createShare() itself permits a never-expiring share for the
// web UI — a permanent public link for a private resource is exactly what
// §11 says never to hand out.
export function createOrgFileDownloadUrl(orgId, userId, fileId, { expiresInSeconds = 3600 } = {}) {
  const file = getFile(fileId);
  if (!file || file.orgId !== orgId) { const err = new Error("File not found."); err.code = "NOT_FOUND"; throw err; }
  const expiresAt = new Date(Date.now() + Math.min(Math.max(expiresInSeconds, 60), 7 * 24 * 3600) * 1000).toISOString();
  const share = createShare(userId, fileId, { expiresAt, downloadOnly: true });
  return { url: `/api/share/${share.token}`, expiresAt };
}
