import { Router } from "express";
import multer from "multer";
import { requireApiKey, requireScope } from "./auth.js";
import { apiRateLimit } from "./rateLimit.js";
import { apiError, apiErrorFromException } from "./errors.js";
import { parsePagination, paginate, cursorWhereClause } from "./pagination.js";
import { listOrgFiles, getOrgFile, uploadOrgFile, downloadOrgFile, deleteOrgFile, createOrgFileDownloadUrl } from "../orchestrator/fileApiService.js";

// Same limit routes/files.js's internal upload endpoint already uses — kept
// as its own instance rather than importing routes/files.js's, so publicApi/
// stays self-contained and never reaches back into routes/.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const router = Router();
router.use(requireApiKey, apiRateLimit());

router.get("/", requireScope("files:read"), (req, res) => {
  const { limit, cursor } = parsePagination(req);
  const rows = listOrgFiles(req.orgId, { limit, cursorClause: cursorWhereClause(cursor), folderId: req.query.folderId });
  const { data, pagination } = paginate(rows, limit);
  res.json({ data, pagination });
});

router.get("/:id", requireScope("files:read"), (req, res) => {
  const file = getOrgFile(req.orgId, req.params.id);
  if (!file) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested file was not found.");
  res.json(file);
});

router.post("/upload", requireScope("files:write"), upload.single("file"), async (req, res) => {
  if (!req.file) return apiError(res, 400, "INVALID_REQUEST", "No file uploaded (expected multipart field \"file\").");
  try {
    const { folderId, visibility, tags } = req.body || {};
    const parsedTags = tags ? String(tags).split(",").map((t) => t.trim()).filter(Boolean) : [];
    const file = await uploadOrgFile(req.orgId, req.apiKey.userId, {
      buffer: req.file.buffer, filename: req.file.originalname, mimeType: req.file.mimetype, folderId, visibility, tags: parsedTags,
    });
    res.status(201).json(file);
  } catch (err) {
    apiErrorFromException(res, err, "Upload failed.");
  }
});

// Streams the file's bytes directly, authenticated by the same API key —
// simplest path for a machine client. /download-url below is the
// alternative for handing a link to something else (a browser, another
// service) without sharing the API key itself.
router.get("/:id/content", requireScope("files:read"), async (req, res) => {
  try {
    const { buffer, file } = await downloadOrgFile(req.orgId, req.apiKey.userId, req.params.id);
    res.set("Content-Type", file.mimeType || "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="${file.originalFilename}"`);
    res.send(buffer);
  } catch (err) {
    apiErrorFromException(res, err, "Download failed.");
  }
});

router.post("/:id/download-url", requireScope("files:read"), (req, res) => {
  try {
    const expiresInSeconds = Number(req.body?.expiresInSeconds) || undefined;
    res.json(createOrgFileDownloadUrl(req.orgId, req.apiKey.userId, req.params.id, { expiresInSeconds }));
  } catch (err) {
    apiErrorFromException(res, err, "Could not create a download link.");
  }
});

router.delete("/:id", requireScope("files:write"), (req, res) => {
  try {
    res.json(deleteOrgFile(req.orgId, req.apiKey.userId, req.params.id));
  } catch (err) {
    apiErrorFromException(res, err, "Could not delete file.");
  }
});

export default router;
