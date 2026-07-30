import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";

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
  res.json({
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    sourceUrls: JSON.parse(row.sourceUrls || "[]"),
    content: JSON.parse(row.content || "{}"),
  });
});

// Deletion via the direct API still requires ownership, same as the
// conversational delete_saved_research tool — this path just skips the
// chat confirmation UI since it's an explicit click on the user's own page.
router.delete("/knowledge/:id", (req, res) => {
  const owned = db.prepare("SELECT id, title FROM knowledge_items WHERE id = ? AND userId = ?").get(req.params.id, req.session.userId);
  if (!owned) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM knowledge_items WHERE id = ? AND userId = ?").run(req.params.id, req.session.userId);
  logActivity(db, req.session.userId, "research_deleted", `Deleted saved research: "${owned.title}"`);
  res.json({ ok: true });
});

export default router;
