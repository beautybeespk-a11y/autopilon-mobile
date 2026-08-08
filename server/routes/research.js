import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { cryptoRandom } from "../middleware.js";
import { extractTextFromFile } from "../tools/research/documentExtract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "knowledge");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB — generous for docs/PDFs, keeps disk use sane

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Prefix with a random id so two people uploading "report.pdf" never
    // collide; keep the original extension so extraction can key off it.
    const ext = path.extname(file.originalname);
    cb(null, `${cryptoRandom()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });

const router = Router();
router.use(requireAuth);

// Read-only browsing doesn't need AI-tool confirmation — it's the user
// looking at their own data, not an action being taken on their behalf.
router.get("/knowledge", (req, res) => {
  const rows = db.prepare(
    "SELECT id, type, title, category, tags, sourceUrls, createdAt FROM knowledge_items WHERE userId = ? ORDER BY createdAt DESC"
  ).all(req.session.userId);
  res.json(rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]"), sourceUrls: JSON.parse(r.sourceUrls || "[]") })));
});

router.get("/knowledge/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ? AND userId = ?").get(req.params.id, req.session.userId);
  if (!row) return res.status(404).json({ error: "Not found" });
  const content = JSON.parse(row.content || "{}");
  // storagePath is server-internal (used by the /file download route below)
  // — never expose it to the client.
  delete content.storagePath;
  res.json({
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    sourceUrls: JSON.parse(row.sourceUrls || "[]"),
    content,
  });
});

// Uploads a document (PDF, DOCX, TXT, MD, CSV, or other), extracts what text
// it can, and stores it as a knowledge_items row with type "document". Once
// stored, it's automatically visible via list_saved_research and searchable
// via search_knowledge — no separate agent tool needed, since both already
// operate over this same table.
router.post("/knowledge/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const { originalname, mimetype, size, path: storagePath } = req.file;
  try {
    const { text, note } = await extractTextFromFile(storagePath, originalname, mimetype);
    const id = cryptoRandom();
    const now = new Date().toISOString();
    const title = req.body.title?.trim() || originalname;

    db.prepare(
      `INSERT INTO knowledge_items (id, userId, type, title, category, tags, content, sourceUrls, ownerAgentId, visibility, editable, createdAt)
       VALUES (?, ?, 'document', ?, ?, ?, ?, ?, NULL, 'shared', 'editable', ?)`
    ).run(
      id,
      req.session.userId,
      title,
      "Document",
      JSON.stringify([]),
      JSON.stringify({ extractedText: text, mimeType: mimetype, originalFilename: originalname, fileSizeBytes: size, storagePath, note: note || null }),
      JSON.stringify([]),
      now
    );

    logActivity(db, req.session.userId, "document_uploaded", `Uploaded document: "${title}"`);

    res.json({
      id,
      type: "document",
      title,
      category: "Document",
      tags: [],
      sourceUrls: [],
      createdAt: now,
      fileSizeBytes: size,
      mimeType: mimetype,
      searchable: Boolean(text),
      note: note || null,
      // Included so callers (e.g. the chat composer's file-attach flow) can
      // use the file's content immediately without a second round-trip —
      // the file is also saved to the Knowledge Library either way.
      extractedText: text,
    });
  } catch (err) {
    // Clean up the orphaned file on disk if something failed after upload.
    fs.unlink(storagePath, () => {});
    res.status(500).json({ error: `Upload failed: ${err.message}` });
  }
});

// Streams the original uploaded file back — used by "download"/"open" in
// the UI. Ownership is checked the same way every other route here does.
router.get("/knowledge/:id/file", (req, res) => {
  const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ? AND userId = ? AND type = 'document'")
    .get(req.params.id, req.session.userId);
  if (!row) return res.status(404).json({ error: "Not found" });

  const content = JSON.parse(row.content || "{}");
  if (!content.storagePath || !fs.existsSync(content.storagePath)) {
    return res.status(404).json({ error: "The original file is no longer available." });
  }
  res.download(content.storagePath, content.originalFilename || row.title);
});

// Deletion via the direct API still requires ownership, same as the
// conversational delete_saved_research tool — this path just skips the
// chat confirmation UI since it's an explicit click on the user's own page.
router.delete("/knowledge/:id", (req, res) => {
  const owned = db.prepare("SELECT id, title, type, content FROM knowledge_items WHERE id = ? AND userId = ?").get(req.params.id, req.session.userId);
  if (!owned) return res.status(404).json({ error: "Not found" });

  // For documents, also remove the file on disk so uploads don't accumulate
  // forever after the knowledge item referencing them is deleted.
  if (owned.type === "document") {
    try {
      const content = JSON.parse(owned.content || "{}");
      if (content.storagePath) fs.unlink(content.storagePath, () => {});
    } catch {
      // malformed content JSON shouldn't block deletion of the row itself
    }
  }

  db.prepare("DELETE FROM knowledge_items WHERE id = ? AND userId = ?").run(req.params.id, req.session.userId);
  logActivity(db, req.session.userId, "research_deleted", `Deleted saved research: "${owned.title}"`);
  res.json({ ok: true });
});

export default router;
