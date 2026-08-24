import { Router } from "express";
import db from "../db.js";
import { requireAuth, requirePlatformAdmin, cryptoRandom, logActivity } from "../middleware.js";

const router = Router();
router.use(requireAuth);

const VALID_TYPES = new Set(["bug", "feature", "general"]);

// Beta users submit feedback from wherever they are in the app (Task 12) —
// deliberately small: type + message + which page they were on, nothing
// that needs its own service or duplicates what activity logging already
// does elsewhere.
router.post("/", (req, res) => {
  const { type, message, page } = req.body || {};
  if (!VALID_TYPES.has(type)) return res.status(400).json({ error: "type must be one of: bug, feature, general." });
  if (!message || !message.trim()) return res.status(400).json({ error: "message is required." });
  if (message.length > 5000) return res.status(400).json({ error: "message is too long (max 5000 characters)." });

  const id = cryptoRandom();
  db.prepare(
    "INSERT INTO feedback (id, userId, type, message, page, status, createdAt) VALUES (?, ?, ?, ?, ?, 'new', ?)"
  ).run(id, req.session.userId, type, message.trim(), page ? String(page).slice(0, 200) : null, new Date().toISOString());
  logActivity(db, req.session.userId, "feedback_submitted", `Submitted ${type} feedback`, { req });
  res.status(201).json({ ok: true });
});

// Platform-admin only — the beta feedback inbox (Task 13).
router.get("/", requirePlatformAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT f.id, f.type, f.message, f.page, f.status, f.createdAt, u.name AS userName, u.email AS userEmail
     FROM feedback f JOIN users u ON u.id = f.userId
     ORDER BY f.createdAt DESC LIMIT 200`
  ).all();
  res.json(rows);
});

router.patch("/:id", requirePlatformAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!["new", "reviewed", "resolved"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  const result = db.prepare("UPDATE feedback SET status = ? WHERE id = ?").run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Feedback not found." });
  res.json({ ok: true });
});

export default router;
