import { Router } from "express";
import db from "../db.js";
import { requireAuth, cryptoRandom, logActivity } from "../middleware.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) =>
  res.json(db.prepare("SELECT * FROM tasks WHERE userId = ? ORDER BY createdAt DESC").all(req.session.userId))
);

router.post("/", (req, res) => {
  const { title, description, priority, dueDate } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: "Task title is required." });
  const id = cryptoRandom();
  db.prepare(
    "INSERT INTO tasks (id, userId, title, description, status, priority, dueDate, createdAt) VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)"
  ).run(id, req.session.userId, title, description || "", priority || "medium", dueDate || null, new Date().toISOString());
  logActivity(db, req.session.userId, "task_created", `Added task "${title}"`);
  res.json({ id });
});

export default router;
