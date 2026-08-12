import fs from "fs";
import os from "os";
import path from "path";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getStorageProvider } from "../storage/provider.js";
import { processFile } from "./fileProcessing.js";
import { getFile, requireFileAccess } from "./fileService.js";
import { logFileActivity } from "./fileActivity.js";
import { publishEvent } from "../automation/triggers.js";

const now = () => new Date().toISOString();

async function withTempFile(buffer, extension, fn) {
  const tmpPath = path.join(os.tmpdir(), `filever-${cryptoRandom()}${extension ? "." + extension : ""}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return await fn(tmpPath);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

export function listVersions(userId, fileId) {
  requireFileAccess(userId, fileId, "view");
  return db.prepare("SELECT * FROM file_versions WHERE fileId = ? ORDER BY version DESC").all(fileId);
}

// Uploads new content under the SAME file record — never silently
// overwrites what's there: the previous version's bytes stay in storage
// under their own key, addressable via listVersions()/restoreVersion().
export async function uploadNewVersion(userId, fileId, { buffer, originalFilename, mimeType, note }) {
  const file = requireFileAccess(userId, fileId, "edit");
  const nextVersion = file.version + 1;
  const extension = file.extension;
  const storageKey = `${file.ownerId}/${fileId}.v${nextVersion}${extension ? "." + extension : ""}`;
  const provider = getStorageProvider(file.storageProvider);
  const uploadResult = await provider.upload({ key: storageKey, buffer });

  const { processing } = await withTempFile(buffer, extension, async (tmpPath) => ({
    processing: await processFile({ filePath: tmpPath, filename: originalFilename || file.originalFilename, mimeType: mimeType || file.mimeType, extension }),
  }));

  const ts = now();
  db.prepare(
    `INSERT INTO file_versions (id, fileId, version, storageProvider, storageKey, sizeBytes, checksum, uploaderId, note, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cryptoRandom(), fileId, nextVersion, provider.name, uploadResult.storageKey, uploadResult.sizeBytes, uploadResult.checksum, userId, note || null, ts);

  db.prepare(
    `UPDATE files SET version = ?, storageProvider = ?, storageKey = ?, sizeBytes = ?, checksum = ?,
       processingStatus = ?, processingError = ?, aiProcessingStatus = ?,
       previewSupport = ?, textExtractionSupport = ?, aiAnalysisSupport = ?, extractedText = ?, updatedAt = ?
     WHERE id = ?`
  ).run(
    nextVersion, provider.name, uploadResult.storageKey, uploadResult.sizeBytes, uploadResult.checksum,
    processing.processingStatus, processing.processingError, processing.aiProcessingStatus,
    processing.previewSupport ? 1 : 0, processing.textExtractionSupport ? 1 : 0, processing.aiAnalysisSupport ? 1 : 0, processing.extractedText,
    ts, fileId
  );

  logFileActivity(fileId, "version_created", { userId, orgId: file.orgId, workspaceId: file.workspaceId, detail: `v${nextVersion}${note ? `: ${note}` : ""}` });
  publishEvent(userId, "files", "file_updated", { fileId, version: nextVersion });
  return getFile(fileId);
}

// Restoring never deletes newer history — it copies the target version's
// bytes into a brand-new version on top (version N+1), same principle as
// git revert vs. reset. Nothing is ever silently lost.
export async function restoreVersion(userId, fileId, targetVersion) {
  const file = requireFileAccess(userId, fileId, "edit");
  const target = db.prepare("SELECT * FROM file_versions WHERE fileId = ? AND version = ?").get(fileId, targetVersion);
  if (!target) {
    const err = new Error("Version not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  const nextVersion = file.version + 1;
  const provider = getStorageProvider(target.storageProvider);
  const newKey = `${file.ownerId}/${fileId}.v${nextVersion}${file.extension ? "." + file.extension : ""}`;
  await provider.copy({ fromKey: target.storageKey, toKey: newKey });

  // Re-run processing against the RESTORED bytes, not the version being
  // replaced — without this, files.extractedText (and preview/AI-analysis
  // flags) would keep describing the content this restore just replaced,
  // making full-text search silently wrong until the next edit.
  const restoredBuffer = await provider.download({ key: newKey });
  const { processing } = await withTempFile(restoredBuffer, file.extension, async (tmpPath) => ({
    processing: await processFile({ filePath: tmpPath, filename: file.originalFilename, mimeType: file.mimeType, extension: file.extension }),
  }));

  const ts = now();
  db.prepare(
    `INSERT INTO file_versions (id, fileId, version, storageProvider, storageKey, sizeBytes, checksum, uploaderId, note, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cryptoRandom(), fileId, nextVersion, provider.name, newKey, target.sizeBytes, target.checksum, userId, `Restored from v${targetVersion}`, ts);

  db.prepare(
    `UPDATE files SET version = ?, storageProvider = ?, storageKey = ?, sizeBytes = ?, checksum = ?,
       processingStatus = ?, processingError = ?, aiProcessingStatus = ?,
       previewSupport = ?, textExtractionSupport = ?, aiAnalysisSupport = ?, extractedText = ?, updatedAt = ?
     WHERE id = ?`
  ).run(
    nextVersion, provider.name, newKey, target.sizeBytes, target.checksum,
    processing.processingStatus, processing.processingError, processing.aiProcessingStatus,
    processing.previewSupport ? 1 : 0, processing.textExtractionSupport ? 1 : 0, processing.aiAnalysisSupport ? 1 : 0, processing.extractedText,
    ts, fileId
  );

  logFileActivity(fileId, "version_created", { userId, orgId: file.orgId, workspaceId: file.workspaceId, detail: `Restored v${targetVersion} as v${nextVersion}` });
  return getFile(fileId);
}
