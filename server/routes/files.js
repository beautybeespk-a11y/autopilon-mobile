import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware.js";
import { storageStatus } from "../storage/provider.js";
import { securityStatus } from "../storage/fileSecurity.js";
import {
  uploadFile, downloadFile, listFiles, getFile, requireFileAccess,
  renameFile, moveFile, setFileTags, setFileVisibility, toggleFavorite,
  trashFile, restoreFile, permanentlyDeleteFile, withTags,
} from "../orchestrator/fileService.js";
import { listVersions, uploadNewVersion, restoreVersion } from "../orchestrator/fileVersions.js";
import { createShare, listShares, revokeShare } from "../orchestrator/fileShare.js";
import { listFileActivity } from "../orchestrator/fileActivity.js";
import { getStorageUsage, checkStorageQuota } from "../orchestrator/storageUsage.js";
import {
  createFolder, listFolders, getFolder, folderBreadcrumb, renameFolder, moveFolder,
  trashFolder, restoreFolder, permanentlyDeleteFolder, requireFolderAccess,
} from "../orchestrator/folderService.js";
import db from "../db.js";
import { cryptoRandom, logActivity } from "../middleware.js";

// memoryStorage rather than diskStorage: uploadFile() already wants a
// Buffer (it hands bytes straight to the configured storage provider), and
// every downstream processing/security check also needs a real Buffer to
// work with — no intermediate temp file to remember to clean up if a
// request fails partway through.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const router = Router();
router.use(requireAuth);

const ERROR_STATUS = {
  NOT_FOUND: 404, FORBIDDEN: 403, QUOTA_EXCEEDED: 403, FILE_TOO_LARGE: 413, INVALID: 400,
};

function handleError(res, err, fallbackMessage) {
  console.error("[files]", err);
  const status = ERROR_STATUS[err.code] || 500;
  res.status(status).json({ error: status === 500 ? fallbackMessage : err.message });
}

router.get("/status", (req, res) => {
  res.json({ storage: storageStatus(), security: securityStatus() });
});

router.get("/usage", (req, res) => {
  const { orgId } = req.query;
  res.json({ usage: getStorageUsage({ orgId: orgId || null, userId: req.session.userId }), quota: checkStorageQuota(orgId || null, 0) });
});

// --- Folders ---

router.post("/folders", (req, res) => {
  try {
    const { name, parentFolderId, orgId, workspaceId, projectId, visibility } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "Folder name is required." });
    const folder = createFolder({ userId: req.session.userId, name: name.trim(), parentFolderId, orgId, workspaceId, projectId, visibility });
    res.json(folder);
  } catch (err) { handleError(res, err, "Couldn't create folder."); }
});

router.get("/folders", (req, res) => {
  const { parentFolderId, orgId, workspaceId, projectId, trashed } = req.query;
  const folders = listFolders({
    userId: req.session.userId,
    parentFolderId: parentFolderId === undefined ? null : (parentFolderId || null),
    orgId: orgId || undefined, workspaceId: workspaceId || undefined, projectId: projectId || undefined,
    trashed: trashed === "true",
  });
  res.json(folders);
});

router.get("/folders/:id/breadcrumb", (req, res) => {
  try {
    requireFolderAccess(req.session.userId, req.params.id, "view");
    res.json(folderBreadcrumb(req.params.id));
  } catch (err) { handleError(res, err, "Couldn't load folder."); }
});

router.patch("/folders/:id", (req, res) => {
  try {
    const { name, parentFolderId } = req.body || {};
    let folder = getFolder(req.params.id);
    if (name !== undefined) folder = renameFolder(req.session.userId, req.params.id, name);
    if (parentFolderId !== undefined) folder = moveFolder(req.session.userId, req.params.id, parentFolderId || null);
    res.json(folder);
  } catch (err) { handleError(res, err, "Couldn't update folder."); }
});

router.delete("/folders/:id", (req, res) => {
  try {
    trashFolder(req.session.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err, "Couldn't delete folder."); }
});

router.post("/folders/:id/restore", (req, res) => {
  try {
    restoreFolder(req.session.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err, "Couldn't restore folder."); }
});

router.delete("/folders/:id/permanent", async (req, res) => {
  try {
    await permanentlyDeleteFolder(req.session.userId, req.params.id, (userId, fileId) => permanentlyDeleteFile(userId, fileId));
    res.json({ ok: true });
  } catch (err) { handleError(res, err, "Couldn't permanently delete folder."); }
});

// --- Files ---

router.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const { folderId, orgId, workspaceId, projectId, visibility, tags, agentId, conversationId } = req.body || {};
    const parsedTags = tags ? (Array.isArray(tags) ? tags : String(tags).split(",")).map((t) => t.trim()).filter(Boolean) : [];
    const file = await uploadFile({
      userId: req.session.userId, orgId: orgId || null, workspaceId: workspaceId || null, projectId: projectId || null, folderId: folderId || null,
      buffer: req.file.buffer, originalFilename: req.file.originalname, mimeType: req.file.mimetype,
      visibility, tags: parsedTags, agentId: agentId || null, conversationId: conversationId || null,
    });
    logActivity(db, req.session.userId, "file_uploaded", `Uploaded "${file.originalFilename}"`, { orgId: orgId || null, workspaceId: workspaceId || null, req });
    res.json(file);
  } catch (err) { handleError(res, err, "Upload failed."); }
});

router.get("/", (req, res) => {
  const { q, folderId, tag, extension, ownerId, projectId, workspaceId, orgId, favoritesOnly, recentOnly, sharedWithMe, trashed, limit } = req.query;
  const files = listFiles(req.session.userId, {
    q: q || undefined,
    folderId: folderId === undefined ? undefined : (folderId || null),
    tag: tag || undefined, extension: extension || undefined, ownerId: ownerId || undefined,
    projectId: projectId || undefined, workspaceId: workspaceId || undefined, orgId: orgId || undefined,
    favoritesOnly: favoritesOnly === "true", recentOnly: recentOnly === "true", sharedWithMe: sharedWithMe === "true",
    trashed: trashed === "true", limit: limit ? Number(limit) : undefined,
  });
  res.json(files);
});

router.get("/:id", (req, res) => {
  try {
    const file = requireFileAccess(req.session.userId, req.params.id, "view");
    res.json(withTags(file));
  } catch (err) { handleError(res, err, "Couldn't load file."); }
});

router.get("/:id/content", async (req, res) => {
  try {
    const { buffer, file } = await downloadFile(req.session.userId, req.params.id, { version: req.query.version ? Number(req.query.version) : undefined });
    res.set("Content-Type", file.mimeType || "application/octet-stream");
    res.set("Content-Disposition", `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.send(buffer);
  } catch (err) { handleError(res, err, "Couldn't download file."); }
});

router.patch("/:id", (req, res) => {
  try {
    const { filename, folderId, tags, favorite } = req.body || {};
    let file = getFile(req.params.id);
    if (filename !== undefined) file = renameFile(req.session.userId, req.params.id, filename);
    if (folderId !== undefined) file = moveFile(req.session.userId, req.params.id, folderId || null);
    if (tags !== undefined) file = setFileTags(req.session.userId, req.params.id, Array.isArray(tags) ? tags : String(tags).split(","));
    if (favorite !== undefined) file = toggleFavorite(req.session.userId, req.params.id, Boolean(favorite));
    res.json(file);
  } catch (err) { handleError(res, err, "Couldn't update file."); }
});

router.patch("/:id/visibility", (req, res) => {
  try {
    const file = setFileVisibility(req.session.userId, req.params.id, req.body?.visibility);
    res.json(file);
  } catch (err) { handleError(res, err, "Couldn't update sharing."); }
});

router.delete("/:id", (req, res) => {
  try {
    res.json(trashFile(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't delete file."); }
});

router.post("/:id/restore", (req, res) => {
  try {
    res.json(restoreFile(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't restore file."); }
});

router.delete("/:id/permanent", async (req, res) => {
  try {
    res.json(await permanentlyDeleteFile(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't permanently delete file."); }
});

// --- Versions ---

router.get("/:id/versions", (req, res) => {
  try {
    res.json(listVersions(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't load versions."); }
});

router.post("/:id/versions", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const file = await uploadNewVersion(req.session.userId, req.params.id, {
      buffer: req.file.buffer, originalFilename: req.file.originalname, mimeType: req.file.mimetype, note: req.body?.note,
    });
    res.json(file);
  } catch (err) { handleError(res, err, "Couldn't upload new version."); }
});

router.post("/:id/versions/:version/restore", async (req, res) => {
  try {
    res.json(await restoreVersion(req.session.userId, req.params.id, Number(req.params.version)));
  } catch (err) { handleError(res, err, "Couldn't restore that version."); }
});

// --- Activity ---

router.get("/:id/activity", (req, res) => {
  try {
    requireFileAccess(req.session.userId, req.params.id, "view");
    res.json(listFileActivity(req.params.id));
  } catch (err) { handleError(res, err, "Couldn't load activity."); }
});

// --- Sharing ---

router.post("/:id/shares", (req, res) => {
  try {
    const { expiresAt, password, downloadOnly } = req.body || {};
    const share = createShare(req.session.userId, req.params.id, { expiresAt, password, downloadOnly });
    // The token is only ever returned here, at creation — same as an API key.
    res.json({ ...share, hasPassword: Boolean(share.passwordHash) });
  } catch (err) { handleError(res, err, "Couldn't create share link."); }
});

router.get("/:id/shares", (req, res) => {
  try {
    res.json(listShares(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't load share links."); }
});

router.delete("/:id/shares/:shareId", (req, res) => {
  try {
    revokeShare(req.session.userId, req.params.id, req.params.shareId);
    res.json({ ok: true });
  } catch (err) { handleError(res, err, "Couldn't revoke share link."); }
});

// --- Knowledge Library integration ---
// Adds a reference, not a copy: knowledge_items.content.storagePath points
// at the SAME bytes files.js already wrote to disk/S3, and (for local
// storage) at the exact same path research.js's own image/document uploads
// use — nothing is duplicated on disk.
router.post("/:id/add-to-knowledge", async (req, res) => {
  try {
    const file = requireFileAccess(req.session.userId, req.params.id, "view");
    const { getStorageProvider } = await import("../storage/provider.js");
    const provider = getStorageProvider(file.storageProvider);
    if (provider.name !== "local") {
      return res.status(400).json({ error: "Adding a non-local-storage file to the Knowledge Library isn't supported yet." });
    }
    const path = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const storagePath = path.join(__dirname, "..", "uploads", "files", file.storageKey);
    const isImage = Boolean(file.extension && ["jpg", "jpeg", "png", "webp", "gif"].includes(file.extension.toLowerCase()));

    const id = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO knowledge_items (id, userId, type, title, category, tags, content, sourceUrls, ownerAgentId, visibility, editable, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'shared', 'editable', ?)`
    ).run(
      id, req.session.userId, isImage ? "image" : "document", file.filename, isImage ? "Image" : "Document",
      JSON.stringify([]),
      JSON.stringify({ extractedText: file.extractedText || "", mimeType: file.mimeType, originalFilename: file.originalFilename, fileSizeBytes: file.sizeBytes, storagePath, note: null, sourceFileId: file.id }),
      JSON.stringify([]), now
    );
    db.prepare("INSERT OR IGNORE INTO file_links (id, fileId, linkedType, linkedId, createdAt) VALUES (?, ?, 'knowledge', ?, ?)").run(cryptoRandom(), file.id, id, now);
    res.json({ knowledgeItemId: id });
  } catch (err) { handleError(res, err, "Couldn't add to Knowledge Library."); }
});

export default router;
