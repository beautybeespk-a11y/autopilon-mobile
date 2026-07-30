import db from "../db.js";
import { cryptoRandom, logActivity } from "../middleware.js";
import { registerTool } from "./registry.js";
import { publishEvent } from "../automation/triggers.js";

registerTool({
  name: "create_task",
  description: "Creates a task for the authenticated user.",
  category: "productivity",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      dueDate: { type: "string" },
    },
    required: ["title"],
  },
  requiredPermissions: ["tasks.write"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId } = context;
    const id = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO tasks (id, userId, title, description, status, priority, dueDate, createdAt) VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)"
    ).run(id, userId, parameters.title, parameters.description || "", parameters.priority || "medium", parameters.dueDate || null, now);
    logActivity(db, userId, "task_created", `Added task "${parameters.title}"`);
    publishEvent(userId, "internal", "task_created", { taskId: id, title: parameters.title, priority: parameters.priority || "medium" });
    return { taskId: id, title: parameters.title, status: "todo" };
  },
});

registerTool({
  name: "list_tasks",
  description: "Returns tasks belonging to the authenticated user, optionally filtered.",
  category: "productivity",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string" },
      priority: { type: "string" },
    },
    required: [],
  },
  requiredPermissions: ["tasks.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId } = context;
    let sql = "SELECT id, title, description, status, priority, dueDate FROM tasks WHERE userId = ?";
    const args = [userId];
    if (parameters.status) { sql += " AND status = ?"; args.push(parameters.status); }
    if (parameters.priority) { sql += " AND priority = ?"; args.push(parameters.priority); }
    sql += " ORDER BY createdAt DESC";
    const tasks = db.prepare(sql).all(...args);
    return { tasks, count: tasks.length };
  },
});

function loadOwnedTask(taskId, userId) {
  return db.prepare("SELECT * FROM tasks WHERE id = ? AND userId = ?").get(taskId, userId);
}

registerTool({
  name: "update_task",
  description: "Updates an existing task belonging to the authenticated user.",
  category: "productivity",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      priority: { type: "string" },
      status: { type: "string" },
      dueDate: { type: "string" },
    },
    required: ["taskId"],
  },
  requiredPermissions: ["tasks.write"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId } = context;
    const task = loadOwnedTask(parameters.taskId, userId);
    if (!task) {
      const err = new Error("Task not found or not owned by this user.");
      err.code = "NOT_FOUND";
      throw err;
    }
    const next = {
      title: parameters.title ?? task.title,
      description: parameters.description ?? task.description,
      priority: parameters.priority ?? task.priority,
      status: parameters.status ?? task.status,
      dueDate: parameters.dueDate ?? task.dueDate,
    };
    db.prepare(
      "UPDATE tasks SET title = ?, description = ?, priority = ?, status = ?, dueDate = ? WHERE id = ? AND userId = ?"
    ).run(next.title, next.description, next.priority, next.status, next.dueDate, task.id, userId);
    logActivity(db, userId, "task_updated", `Updated task "${next.title}"`);
    return { taskId: task.id, ...next };
  },
});

registerTool({
  name: "complete_task",
  description: "Marks an existing task as completed.",
  category: "productivity",
  parameters: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  },
  requiredPermissions: ["tasks.write"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId } = context;
    const task = loadOwnedTask(parameters.taskId, userId);
    if (!task) {
      const err = new Error("Task not found or not owned by this user.");
      err.code = "NOT_FOUND";
      throw err;
    }
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ? AND userId = ?").run(task.id, userId);
    logActivity(db, userId, "task_completed", `Completed task "${task.title}"`);
    publishEvent(userId, "internal", "task_completed", { taskId: task.id, title: task.title });
    return { taskId: task.id, status: "completed" };
  },
});
