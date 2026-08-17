import fs from "fs";
import os from "os";
import path from "path";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getStorageProvider } from "../storage/provider.js";
import { scanFile } from "../storage/fileSecurity.js";
import { processFile } from "./fileProcessing.js";
import { canAccessFile, canAccessFolder, readableFilesClause } from "./filePermissions.js";
import { getFolder, requireFolderAccess } from "./folderService.js";
import { checkStorageQuota, maxUploadBytesFor } from "./storageUsage.js";
import { logFileActivity } from "./fileActivity.js";
import { publishEvent } from "../automation/triggers.js";
import { publishDeveloperWebhookEvent } from "./webhookEvents.js";

const now = () => new Date().toISOString();

function extOf(filename) {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i + 1).toLowerCase();
}

// Blindly rounding to GB reads as "0GB" for any limit under ~1GB — was only
// ever going to bite plans with a small test/demo limit, but a wrong
// user-facing number is a wrong user-facing number.
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

async function withTempFile(buffer, extension, fn) {
  const tmpPath = path.join(os.tmpdir(), `filesvc-${cryptoRandom()}${extension ? "." + extension : ""}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return await fn(tmpPath);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

export function getFile(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id);
}

export function requireFileAccess(userId, fileId, action) {
  const file = getFile(fileId);
  if (!file) {
    const err = new Error("File not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!canAccessFile(userId, file, action)) {
    const err = new Error("You don't have permission to do that.");
    err.code = "FORBIDDEN";
    throw err;
  }
  return file;
}

function fileTags(fileId) {
  return db.prepare("SELECT tag FROM file_tags WHERE fileId = ?").all(fileId).map((r) => r.tag);
}

export function withTags(file) {
  return file ? { ...file, tags: fileTags(file.id) } : file;
}

export async function uploadFile({
  userId, orgId, workspaceId, projectId, folderId, buffer, originalFilename, mimeType, visibility, tags = [], agentId, conversationId,
}) {
  if (folderId) requireFolderAccess(userId, folderId, "view");

  const maxBytes = maxUploadBytesFor(orgId);
  if (maxBytes != null && buffer.length > maxBytes) {
    const err = new Error(`This file is larger than your plan's per-file upload limit (${Math.round(maxBytes / (1024 * 1024))}MB).`);
    err.code = "FILE_TOO_LARGE";
    throw err;
  }

  const quota = checkStorageQuota(orgId, buffer.length);
  if (!quota.allowed) {
    const err = new Error(`This upload would exceed your organization's storage limit (${formatBytes(quota.limit)}).`);
    err.code = "QUOTA_EXCEEDED";
    throw err;
  }

  const id = cryptoRandom();
  const extension = extOf(originalFilename);
  const storageKey = `${userId}/${id}${extension ? "." + extension : ""}`;
  const provider = getStorageProvider();
  const uploadResult = await provider.upload({ key: storageKey, buffer });

  // Processing and security scanning both need a real file path (pdf-parse/
  // mammoth/xlsx all read from disk) — a short-lived temp file gives every
  // storage provider (local or S3) the same code path here, rather than
  // fileService reaching into LocalStorageProvider's internals.
  const { processing, security } = await withTempFile(buffer, extension, async (tmpPath) => ({
    processing: await processFile({ filePath: tmpPath, filename: originalFilename, mimeType, extension }),
    security: await scanFile({ filePath: tmpPath }),
  }));

  const ts = now();
  const columns = [
    "id", "orgId", "workspaceId", "projectId", "folderId", "ownerId", "uploaderId",
    "filename", "originalFilename", "extension", "mimeType", "sizeBytes",
    "storageProvider", "storageKey", "checksum", "version", "status",
    "processingStatus", "processingError", "aiProcessingStatus",
    "securityScanStatus", "securityScanProvider",
    "previewSupport", "textExtractionSupport", "aiAnalysisSupport", "extractedText",
    "visibility", "favorite", "trashedAt", "lastAccessedAt", "createdAt", "updatedAt",
  ];
  const values = [
    id, orgId || null, workspaceId || null, projectId || null, folderId || null, userId, userId,
    originalFilename, originalFilename, extension || null, mimeType || null, uploadResult.sizeBytes,
    provider.name, uploadResult.storageKey, uploadResult.checksum, 1, "active",
    processing.processingStatus, processing.processingError, processing.aiProcessingStatus,
    security.status, security.provider,
    processing.previewSupport ? 1 : 0, processing.textExtractionSupport ? 1 : 0, processing.aiAnalysisSupport ? 1 : 0, processing.extractedText,
    ["private", "workspace", "organization", "shared"].includes(visibility) ? visibility : "private", 0, null, null, ts, ts,
  ];
  db.prepare(`INSERT INTO files (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);

  db.prepare(
    `INSERT INTO file_versions (id, fileId, version, storageProvider, storageKey, sizeBytes, checksum, uploaderId, note, createdAt)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cryptoRandom(), id, provider.name, uploadResult.storageKey, uploadResult.sizeBytes, uploadResult.checksum, userId, "Initial upload", ts);

  for (const tag of tags) {
    if (tag?.trim()) db.prepare("INSERT OR IGNORE INTO file_tags (fileId, tag) VALUES (?, ?)").run(id, tag.trim().toLowerCase());
  }

  logFileActivity(id, "upload", { userId, orgId, workspaceId, projectId, agentId, detail: originalFilename });
  publishEvent(userId, "files", "file_uploaded", { fileId: id, filename: originalFilename, sizeBytes: uploadResult.sizeBytes, folderId: folderId || null, conversationId: conversationId || null });
  publishDeveloperWebhookEvent(orgId, "file.uploaded", { fileId: id, filename: originalFilename, sizeBytes: uploadResult.sizeBytes });
  if (processing.processingStatus === "ready") {
    publishEvent(userId, "files", "file_processing_completed", { fileId: id, filename: originalFilename });
  } else if (processing.processingStatus === "failed") {
    publishEvent(userId, "files", "file_processing_failed", { fileId: id, filename: originalFilename, error: processing.processingError });
  }

  return withTags(getFile(id));
}

// Downloads a specific version's bytes (defaults to current). Bumps
// lastAccessedAt and logs the access — every read goes through here so
// nothing bypasses that bookkeeping.
export async function downloadFile(userId, fileId, { version, agentId, orgId, workspaceId, projectId } = {}) {
  const file = requireFileAccess(userId, fileId, "download");
  let storageProvider = file.storageProvider;
  let storageKey = file.storageKey;
  if (version && version !== file.version) {
    const v = db.prepare("SELECT * FROM file_versions WHERE fileId = ? AND version = ?").get(fileId, version);
    if (!v) {
      const err = new Error("Version not found.");
      err.code = "NOT_FOUND";
      throw err;
    }
    storageProvider = v.storageProvider;
    storageKey = v.storageKey;
  }
  const provider = getStorageProvider(storageProvider);
  const buffer = await provider.download({ key: storageKey });
  db.prepare("UPDATE files SET lastAccessedAt = ? WHERE id = ?").run(now(), fileId);
  logFileActivity(fileId, "download", { userId, agentId, orgId: orgId ?? file.orgId, workspaceId: workspaceId ?? file.workspaceId, projectId: projectId ?? file.projectId });
  return { buffer, file };
}

// Full-text + metadata search, permission-filtered at the SQL level so a
// user never even sees a row (let alone content) they can't access —
// spec §11/§33's "must never discover a file they don't have permission
// to access."
export function listFiles(userId, filters = {}) {
  const {
    q, folderId, tag, extension, ownerId, projectId, workspaceId, orgId,
    favoritesOnly, recentOnly, sharedWithMe, trashed = false, limit = 100,
  } = filters;

  const { sql: accessSql, params: accessParams } = readableFilesClause(userId);
  const clauses = [accessSql, `status = ?`];
  const params = [...accessParams, trashed ? "trashed" : "active"];

  if (folderId !== undefined) {
    clauses.push(folderId ? "folderId = ?" : "folderId IS NULL");
    if (folderId) params.push(folderId);
  }
  if (extension) { clauses.push("extension = ?"); params.push(extension.toLowerCase().replace(/^\./, "")); }
  if (ownerId) { clauses.push("ownerId = ?"); params.push(ownerId); }
  if (projectId) { clauses.push("projectId = ?"); params.push(projectId); }
  if (workspaceId) { clauses.push("workspaceId = ?"); params.push(workspaceId); }
  if (orgId) { clauses.push("orgId = ?"); params.push(orgId); }
  if (favoritesOnly) clauses.push("favorite = 1");
  if (sharedWithMe) { clauses.push("ownerId != ? AND id IN (SELECT fileId FROM file_permissions WHERE subjectType = 'user' AND subjectId = ?)"); params.push(userId, userId); }
  if (tag) { clauses.push("id IN (SELECT fileId FROM file_tags WHERE tag = ?)"); params.push(tag.toLowerCase()); }
  if (q) {
    clauses.push("(filename LIKE ? OR extractedText LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const order = recentOnly ? "ORDER BY lastAccessedAt DESC, updatedAt DESC" : "ORDER BY updatedAt DESC";
  const sql = `SELECT * FROM files WHERE ${clauses.join(" AND ")} ${order} LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map(withTags);
}

export function renameFile(userId, fileId, filename) {
  const file = requireFileAccess(userId, fileId, "edit");
  db.prepare("UPDATE files SET filename = ?, updatedAt = ? WHERE id = ?").run(filename, now(), fileId);
  logFileActivity(fileId, "rename", { userId, orgId: file.orgId, workspaceId: file.workspaceId, detail: `"${file.filename}" -> "${filename}"` });
  return withTags(getFile(fileId));
}

export function moveFile(userId, fileId, folderId) {
  const file = requireFileAccess(userId, fileId, "edit");
  if (folderId) requireFolderAccess(userId, folderId, "view");
  db.prepare("UPDATE files SET folderId = ?, updatedAt = ? WHERE id = ?").run(folderId || null, now(), fileId);
  logFileActivity(fileId, "move", { userId, orgId: file.orgId, workspaceId: file.workspaceId });
  return withTags(getFile(fileId));
}

// Creates an independent new file record with its own storage bytes (a real
// copy, not a second pointer at the same key) — so trashing/permanently
// deleting one copy never touches the other. Only the current version is
// copied; the copy starts fresh at version 1, same as any other upload.
export async function copyFile(userId, fileId, { folderId } = {}) {
  const source = requireFileAccess(userId, fileId, "view");
  if (folderId) requireFolderAccess(userId, folderId, "view");
  const provider = getStorageProvider(source.storageProvider);
  const newId = cryptoRandom();
  const newKey = `${userId}/${newId}${source.extension ? "." + source.extension : ""}`;
  await provider.copy({ fromKey: source.storageKey, toKey: newKey });

  const ts = now();
  const columns = [
    "id", "orgId", "workspaceId", "projectId", "folderId", "ownerId", "uploaderId",
    "filename", "originalFilename", "extension", "mimeType", "sizeBytes",
    "storageProvider", "storageKey", "checksum", "version", "status",
    "processingStatus", "processingError", "aiProcessingStatus",
    "securityScanStatus", "securityScanProvider",
    "previewSupport", "textExtractionSupport", "aiAnalysisSupport", "extractedText",
    "visibility", "favorite", "trashedAt", "lastAccessedAt", "createdAt", "updatedAt",
  ];
  const values = [
    newId, source.orgId, source.workspaceId, source.projectId, folderId !== undefined ? (folderId || null) : source.folderId, userId, userId,
    `Copy of ${source.filename}`, source.originalFilename, source.extension, source.mimeType, source.sizeBytes,
    provider.name, newKey, source.checksum, 1, "active",
    source.processingStatus, source.processingError, source.aiProcessingStatus,
    "not_scanned", null,
    source.previewSupport, source.textExtractionSupport, source.aiAnalysisSupport, source.extractedText,
    "private", 0, null, null, ts, ts,
  ];
  db.prepare(`INSERT INTO files (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
  db.prepare(
    `INSERT INTO file_versions (id, fileId, version, storageProvider, storageKey, sizeBytes, checksum, uploaderId, note, createdAt)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cryptoRandom(), newId, provider.name, newKey, source.sizeBytes, source.checksum, userId, `Copied from ${source.filename}`, ts);
  for (const tag of fileTags(fileId)) db.prepare("INSERT OR IGNORE INTO file_tags (fileId, tag) VALUES (?, ?)").run(newId, tag);

  logFileActivity(newId, "upload", { userId, detail: `Copy of "${source.filename}"` });
  return withTags(getFile(newId));
}

export function setFileTags(userId, fileId, tags) {
  requireFileAccess(userId, fileId, "edit");
  db.prepare("DELETE FROM file_tags WHERE fileId = ?").run(fileId);
  for (const tag of tags) {
    if (tag?.trim()) db.prepare("INSERT OR IGNORE INTO file_tags (fileId, tag) VALUES (?, ?)").run(fileId, tag.trim().toLowerCase());
  }
  db.prepare("UPDATE files SET updatedAt = ? WHERE id = ?").run(now(), fileId);
  return withTags(getFile(fileId));
}

export function setFileVisibility(userId, fileId, visibility) {
  const file = requireFileAccess(userId, fileId, "share");
  if (!["private", "workspace", "organization", "shared"].includes(visibility)) {
    const err = new Error("Invalid visibility value.");
    err.code = "INVALID";
    throw err;
  }
  db.prepare("UPDATE files SET visibility = ?, updatedAt = ? WHERE id = ?").run(visibility, now(), fileId);
  logFileActivity(fileId, "permission_changed", { userId, orgId: file.orgId, workspaceId: file.workspaceId, detail: `visibility -> ${visibility}` });
  return withTags(getFile(fileId));
}

export function toggleFavorite(userId, fileId, favorite) {
  requireFileAccess(userId, fileId, "view");
  db.prepare("UPDATE files SET favorite = ?, updatedAt = ? WHERE id = ?").run(favorite ? 1 : 0, now(), fileId);
  return withTags(getFile(fileId));
}

export function trashFile(userId, fileId) {
  const file = requireFileAccess(userId, fileId, "delete");
  db.prepare("UPDATE files SET status = 'trashed', trashedAt = ?, updatedAt = ? WHERE id = ?").run(now(), now(), fileId);
  logFileActivity(fileId, "delete", { userId, orgId: file.orgId, workspaceId: file.workspaceId });
  return { fileId, trashed: true };
}

export function restoreFile(userId, fileId) {
  const file = requireFileAccess(userId, fileId, "delete");
  db.prepare("UPDATE files SET status = 'active', trashedAt = NULL, updatedAt = ? WHERE id = ?").run(now(), fileId);
  logFileActivity(fileId, "restore", { userId, orgId: file.orgId, workspaceId: file.workspaceId });
  return withTags(getFile(fileId));
}

// Deletes every version's bytes from storage, then the DB row (FK cascade
// takes care of file_versions/file_permissions/file_tags/file_shares/
// file_activity/file_links). This is the one truly irreversible operation
// in the whole file system — never called automatically, only from an
// explicit "delete forever" action the route requires confirmation for.
export async function permanentlyDeleteFile(userId, fileId) {
  const file = requireFileAccess(userId, fileId, "delete");
  const versions = db.prepare("SELECT storageProvider, storageKey FROM file_versions WHERE fileId = ?").all(fileId);
  const seen = new Set();
  for (const v of versions) {
    const dedupeKey = `${v.storageProvider}:${v.storageKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    await getStorageProvider(v.storageProvider).delete({ key: v.storageKey });
  }
  // Logged BEFORE the delete, not after — file_activity.fileId has an FK
  // (ON DELETE CASCADE) to files.id, and this DB runs with foreign_keys=ON,
  // so inserting an activity row for an already-deleted file would fail.
  // This row is deleted along with everything else by the cascade itself;
  // it exists here only in case something between these two lines fails.
  logFileActivity(fileId, "delete", { userId, orgId: file.orgId, workspaceId: file.workspaceId, detail: "permanent" });
  db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  return { fileId, permanentlyDeleted: true };
}

export { canAccessFolder };
