import db from "../db.js";
import { cryptoRandom, logActivity } from "../middleware.js";
import { registerTool } from "./registry.js";

// Visibility model: a memory created without an agent context (agentId
// NULL, e.g. plain chat) stays visible to every agent, same as before this
// was added. A memory an agent creates as 'private' is visible only to
// that same agent — real isolation. 'shared' (the default) means any agent
// can read it, but only the owning agent (or a legacy NULL-owner memory)
// can delete it — sharing is about read access, not handing out delete
// rights over someone else's memory.
registerTool({
  name: "create_memory",
  description: "Permanently stores a piece of information about the user for future conversations. Private memories are visible only to you; shared ones (the default) are visible to all your agents.",
  category: "memory",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string" },
      type: { type: "string" },
      visibility: { type: "string", description: "'shared' (default, visible to all your agents) or 'private' (visible only to you)" },
    },
    required: ["content", "type"],
  },
  requiredPermissions: ["memory.write"],
  requiresConfirmation: true, // The AI must never save a memory without explicit approval.
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const visibility = parameters.visibility === "private" ? "private" : "shared";
    const id = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO memories (id, userId, content, type, agentId, visibility, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, userId, parameters.content, parameters.type || "note", agentId || null, visibility, now);
    logActivity(db, userId, "memory_created", `Saved a ${visibility} memory`);
    return { memoryId: id, content: parameters.content, type: parameters.type || "note", visibility };
  },
});

registerTool({
  name: "list_memories",
  description: "Returns memories visible to you: everything shared, plus anything you privately own.",
  category: "memory",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["memory.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const memories = db.prepare(
      `SELECT id, content, type, agentId, visibility, createdAt FROM memories
       WHERE userId = ? AND (agentId IS NULL OR agentId = ? OR visibility = 'shared')
       ORDER BY createdAt DESC`
    ).all(userId, agentId || null);
    return { memories, count: memories.length };
  },
});

registerTool({
  name: "delete_memory",
  description: "Permanently deletes a memory you own (or a legacy/general one). You can't delete another agent's private memory.",
  category: "memory",
  parameters: {
    type: "object",
    properties: { memoryId: { type: "string" } },
    required: ["memoryId"],
  },
  requiredPermissions: ["memory.delete"],
  requiresConfirmation: true, // Deletion is irreversible; must be explicitly confirmed.
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const owned = db.prepare(
      "SELECT id FROM memories WHERE id = ? AND userId = ? AND (agentId IS NULL OR agentId = ?)"
    ).get(parameters.memoryId, userId, agentId || null);
    if (!owned) {
      const err = new Error("Memory not found, or it's a private memory owned by a different agent.");
      err.code = "NOT_FOUND";
      throw err;
    }
    db.prepare("DELETE FROM memories WHERE id = ? AND userId = ?").run(parameters.memoryId, userId);
    logActivity(db, userId, "memory_deleted", `Deleted a memory`);
    return { memoryId: parameters.memoryId, deleted: true };
  },
});
