import { Router } from "express";
import db from "../db.js";
import { requireAuth, cryptoRandom, logActivity } from "../middleware.js";
import { createNotification } from "../orchestrator/notifications.js";

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

// Assigning is only meaningful between people who actually share an
// organization — otherwise there's no basis for one account to hand work
// to another. Only the task's owner can assign it.
router.post("/:id/assign", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND userId = ?").get(req.params.id, req.session.userId);
  if (!task) return res.status(404).json({ error: "Task not found." });
  const { assignedToUserId } = req.body || {};
  if (!assignedToUserId) return res.status(400).json({ error: "assignedToUserId is required." });

  const sharedOrg = db.prepare(
    `SELECT om1.orgId FROM organization_members om1
     JOIN organization_members om2 ON om2.orgId = om1.orgId
     WHERE om1.userId = ? AND om1.status = 'active' AND om2.userId = ? AND om2.status = 'active' LIMIT 1`
  ).get(req.session.userId, assignedToUserId);
  if (!sharedOrg) return res.status(403).json({ error: "You can only assign tasks to people you share an organization with." });

  db.prepare("UPDATE tasks SET assignedToUserId = ? WHERE id = ?").run(assignedToUserId, req.params.id);
  const assigner = db.prepare("SELECT name FROM users WHERE id = ?").get(req.session.userId);
  createNotification(assignedToUserId, {
    type: "assignment",
    title: `${assigner?.name || "Someone"} assigned you a task`,
    body: task.title,
    link: "/app/tasks",
  });
  logActivity(db, req.session.userId, "task_assigned", `Assigned task "${task.title}"`, { orgId: sharedOrg.orgId, req });
  res.json({ ok: true });
});

export default router;
