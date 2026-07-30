import db from "../../db.js";
import { cryptoRandom, logActivity } from "../../middleware.js";
import { registerTool } from "../registry.js";

// Single table backs the Knowledge Library. Reports, notes, saved URLs, and
// summaries are all "knowledge items" distinguished by `type` — one flexible
// table instead of four near-duplicate ones, since the fields (title,
// content, tags, sources, owner, date) are the same shape either way.
//
// Visibility model (Phase 8): an item saved without an agent context
// (ownerAgentId NULL, e.g. plain chat) stays visible/editable to every
// agent, same as before this was added — nothing existing changes. An item
// an agent saves as 'private' is visible only to that agent. 'shared' (the
// default) is visible to every agent; whether OTHER agents may edit it too
// is a separate `editable` flag ('editable' or 'read_only') — the owner
// decides both independently.

function canRead(row, agentId) {
  return !row.ownerAgentId || row.ownerAgentId === agentId || row.visibility === "shared";
}
function canWrite(row, agentId) {
  if (!row.ownerAgentId || row.ownerAgentId === agentId) return true; // legacy item, or the owner itself
  return row.visibility === "shared" && row.editable === "editable";
}

registerTool({
  name: "save_research",
  description: "Permanently saves a research report or note to the Knowledge Library. Private items are visible only to you; shared ones (the default) are visible to all your agents, and can optionally be made editable by them too.",
  category: "research",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      category: { type: "string" },
      tags: { type: "array" },
      content: { type: "object" }, // the report object, or { note: "..." }
      sourceUrls: { type: "array" },
      visibility: { type: "string", description: "'shared' (default) or 'private'" },
      editable: { type: "string", description: "when shared: 'editable' (default) or 'read_only' for other agents" },
    },
    required: ["title", "content"],
  },
  requiredPermissions: ["knowledge.write"],
  requiresConfirmation: true, // Nothing is saved to the Knowledge Library without explicit approval.
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const visibility = parameters.visibility === "private" ? "private" : "shared";
    const editable = parameters.editable === "read_only" ? "read_only" : "editable";
    const id = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO knowledge_items (id, userId, type, title, category, tags, content, sourceUrls, ownerAgentId, visibility, editable, createdAt)
       VALUES (?, ?, 'report', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, userId, parameters.title, parameters.category || "research",
      JSON.stringify(parameters.tags || []), JSON.stringify(parameters.content),
      JSON.stringify(parameters.sourceUrls || []), agentId || null, visibility, editable, now
    );
    logActivity(db, userId, "research_saved", `Saved research: "${parameters.title}"`);
    return { itemId: id, title: parameters.title, visibility, editable };
  },
});

registerTool({
  name: "search_knowledge",
  description: "Searches the Knowledge Library items visible to you (your own, plus anything shared) by keyword.",
  category: "research",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  requiredPermissions: ["knowledge.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const like = `%${parameters.query}%`;
    const rows = db.prepare(
      `SELECT id, title, category, tags, ownerAgentId, visibility, editable, createdAt FROM knowledge_items
       WHERE userId = ? AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
             AND (ownerAgentId IS NULL OR ownerAgentId = ? OR visibility = 'shared')
       ORDER BY createdAt DESC LIMIT 20`
    ).all(userId, like, like, like, agentId || null);
    return { query: parameters.query, items: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") })), count: rows.length };
  },
});

registerTool({
  name: "list_saved_research",
  description: "Lists everything in the Knowledge Library visible to you (your own, plus anything shared).",
  category: "research",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["knowledge.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const rows = db.prepare(
      `SELECT id, title, category, tags, ownerAgentId, visibility, editable, createdAt FROM knowledge_items
       WHERE userId = ? AND (ownerAgentId IS NULL OR ownerAgentId = ? OR visibility = 'shared')
       ORDER BY createdAt DESC`
    ).all(userId, agentId || null);
    return { items: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") })), count: rows.length };
  },
});

registerTool({
  name: "update_knowledge_item",
  description: "Updates a Knowledge Library item's title, category, tags, or content — allowed if you own it, or it's shared as editable.",
  category: "research",
  parameters: {
    type: "object",
    properties: {
      itemId: { type: "string" },
      title: { type: "string" },
      category: { type: "string" },
      tags: { type: "array" },
      content: { type: "object" },
    },
    required: ["itemId"],
  },
  requiredPermissions: ["knowledge.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ? AND userId = ?").get(parameters.itemId, userId);
    if (!row) { const err = new Error("Knowledge item not found."); err.code = "NOT_FOUND"; throw err; }
    if (!canWrite(row, agentId)) {
      const err = new Error("This item is private to another agent, or shared read-only — you can't edit it.");
      err.code = "FORBIDDEN";
      throw err;
    }
    db.prepare(
      `UPDATE knowledge_items SET title = COALESCE(?, title), category = COALESCE(?, category),
       tags = COALESCE(?, tags), content = COALESCE(?, content) WHERE id = ?`
    ).run(
      parameters.title, parameters.category,
      parameters.tags ? JSON.stringify(parameters.tags) : null,
      parameters.content ? JSON.stringify(parameters.content) : null,
      parameters.itemId
    );
    logActivity(db, userId, "research_updated", `Updated knowledge item "${parameters.title || row.title}"`);
    return { itemId: parameters.itemId, updated: true };
  },
});

registerTool({
  name: "delete_saved_research",
  description: "Permanently deletes an item from the Knowledge Library — allowed if you own it (shared visibility does not grant delete rights to other agents).",
  category: "research",
  parameters: {
    type: "object",
    properties: { itemId: { type: "string" } },
    required: ["itemId"],
  },
  requiredPermissions: ["knowledge.delete"],
  requiresConfirmation: true, // Deletion is irreversible; must be explicitly confirmed.
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const owned = db.prepare(
      "SELECT id FROM knowledge_items WHERE id = ? AND userId = ? AND (ownerAgentId IS NULL OR ownerAgentId = ?)"
    ).get(parameters.itemId, userId, agentId || null);
    if (!owned) {
      const err = new Error("Knowledge item not found, or it's owned by a different agent.");
      err.code = "NOT_FOUND";
      throw err;
    }
    db.prepare("DELETE FROM knowledge_items WHERE id = ? AND userId = ?").run(parameters.itemId, userId);
    logActivity(db, userId, "research_deleted", "Deleted a saved research item");
    return { itemId: parameters.itemId, deleted: true };
  },
});
