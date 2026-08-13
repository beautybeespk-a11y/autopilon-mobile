import db from "../../db.js";
import { cryptoRandom, logActivity } from "../../middleware.js";
import { registerTool } from "../registry.js";
import { hasPermission } from "../../orchestrator/rbac.js";
import {
  readableKnowledgeClause, canWriteKnowledgeItem, canDeleteKnowledgeItem,
} from "../../orchestrator/knowledgeAccess.js";

// Single table backs the Knowledge Library. Reports, notes, saved URLs, and
// summaries are all "knowledge items" distinguished by `type` — one flexible
// table instead of four near-duplicate ones, since the fields (title,
// content, tags, sources, owner, date) are the same shape either way.
//
// Two independent sharing layers:
// - Phase 8: sharing between ONE account's own agents (agentId ownership +
//   visibility/editable) — an item saved without an agent context stays
//   visible to every agent on the account, same as before Phase 8.
// - Phase 9: sharing ACROSS accounts via an organization/workspace
//   (orgId/workspaceId + crossUserVisibility/crossUserEditable) — defaults
//   to fully private, so nothing becomes newly visible to other people
//   just because this column exists.

function ownAgentCanWrite(row, agentId) {
  if (!row.ownerAgentId || row.ownerAgentId === agentId) return true; // legacy item, or the owning agent itself
  return row.visibility === "shared" && row.editable === "editable";
}

registerTool({
  name: "save_research",
  description: "Permanently saves a research report or note to the Knowledge Library. Can be kept private, shared with your other agents, and/or shared with an organization or workspace you belong to.",
  category: "research",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      category: { type: "string" },
      tags: { type: "array" },
      content: { type: "object" }, // the report object, or { note: "..." }
      sourceUrls: { type: "array" },
      visibility: { type: "string", description: "Sharing with your OWN other agents: 'shared' (default) or 'private'" },
      editable: { type: "string", description: "when shared with your own agents: 'editable' (default) or 'read_only'" },
      orgId: { type: "string", description: "Share with this organization (must have 'knowledge' permission there)" },
      workspaceId: { type: "string", description: "Optionally narrow org sharing to one workspace" },
      crossUserVisibility: { type: "string", description: "'private' (default), 'workspace', 'organization', or 'public'" },
      crossUserEditable: { type: "string", description: "when shared cross-user: 'editable' or 'read_only' (default)" },
    },
    required: ["title", "content"],
  },
  requiredPermissions: ["knowledge.write"],
  requiresConfirmation: true, // Nothing is saved to the Knowledge Library without explicit approval.
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const visibility = parameters.visibility === "private" ? "private" : "shared";
    const editable = parameters.editable === "read_only" ? "read_only" : "editable";
    const crossUserVisibility = ["workspace", "organization", "public"].includes(parameters.crossUserVisibility) ? parameters.crossUserVisibility : "private";
    const crossUserEditable = parameters.crossUserEditable === "editable" ? "editable" : "read_only";

    if (parameters.orgId && !hasPermission(parameters.orgId, userId, "knowledge")) {
      const err = new Error("You don't have knowledge-sharing permission in that organization.");
      err.code = "FORBIDDEN";
      throw err;
    }

    const id = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO knowledge_items
       (id, userId, type, title, category, tags, content, sourceUrls, ownerAgentId, visibility, editable, orgId, workspaceId, crossUserVisibility, crossUserEditable, createdAt)
       VALUES (?, ?, 'report', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, userId, parameters.title, parameters.category || "research",
      JSON.stringify(parameters.tags || []), JSON.stringify(parameters.content),
      JSON.stringify(parameters.sourceUrls || []), agentId || null, visibility, editable,
      parameters.orgId || null, parameters.workspaceId || null, crossUserVisibility, crossUserEditable, now
    );
    logActivity(db, userId, "research_saved", `Saved research: "${parameters.title}"`);
    return { itemId: id, title: parameters.title, visibility, editable, crossUserVisibility, crossUserEditable };
  },
});

registerTool({
  name: "search_knowledge",
  description: "Searches the Knowledge Library items visible to you (your own, plus anything shared with you) by keyword.",
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
    const readable = readableKnowledgeClause(userId);
    const rows = db.prepare(
      `SELECT id, title, category, tags, userId AS ownerUserId, ownerAgentId, visibility, editable, orgId, workspaceId, crossUserVisibility, crossUserEditable, createdAt
       FROM knowledge_items
       WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
             AND ${readable.sql}
       ORDER BY createdAt DESC LIMIT 20`
    ).all(like, like, like, ...readable.params);
    // Own-account items still respect the Phase 8 agent-level filter on top of the Phase 9 cross-user filter above.
    const visible = rows.filter((r) => r.ownerUserId !== userId || !r.ownerAgentId || r.ownerAgentId === agentId || r.visibility === "shared");
    return { query: parameters.query, items: visible.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") })), count: visible.length };
  },
});

registerTool({
  name: "list_saved_research",
  description: "Lists everything in the Knowledge Library visible to you (your own, plus anything shared with you).",
  category: "research",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["knowledge.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { userId, agentId } = context;
    const readable = readableKnowledgeClause(userId);
    const rows = db.prepare(
      `SELECT id, title, category, tags, userId AS ownerUserId, ownerAgentId, visibility, editable, orgId, workspaceId, crossUserVisibility, crossUserEditable, createdAt
       FROM knowledge_items WHERE ${readable.sql} ORDER BY createdAt DESC LIMIT 200`
    ).all(...readable.params);
    const visible = rows.filter((r) => r.ownerUserId !== userId || !r.ownerAgentId || r.ownerAgentId === agentId || r.visibility === "shared");
    return { items: visible.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") })), count: visible.length };
  },
});

registerTool({
  name: "update_knowledge_item",
  description: "Updates a Knowledge Library item's title, category, tags, or content — allowed if you own it, or it's shared as editable (by your own agents, or across your organization/workspace).",
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
    const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ?").get(parameters.itemId);
    if (!row) { const err = new Error("Knowledge item not found."); err.code = "NOT_FOUND"; throw err; }
    const allowed = row.userId === userId ? ownAgentCanWrite(row, agentId) : canWriteKnowledgeItem(userId, row);
    if (!allowed) {
      const err = new Error("You don't have edit access to this item.");
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
  description: "Permanently deletes an item from the Knowledge Library — allowed if you own it, or you're an owner/admin of the organization it's shared with (sharing alone never grants delete rights).",
  category: "research",
  parameters: {
    type: "object",
    properties: { itemId: { type: "string" } },
    required: ["itemId"],
  },
  requiredPermissions: ["knowledge.delete"],
  requiresConfirmation: true, // Deletion is irreversible; must be explicitly confirmed.
  async execute(parameters, context) {
    const { userId } = context;
    const row = db.prepare("SELECT * FROM knowledge_items WHERE id = ?").get(parameters.itemId);
    if (!row || !canDeleteKnowledgeItem(userId, row)) {
      const err = new Error("Knowledge item not found, or you don't have delete rights to it.");
      err.code = "NOT_FOUND";
      throw err;
    }
    db.prepare("DELETE FROM knowledge_items WHERE id = ?").run(parameters.itemId);
    logActivity(db, userId, "research_deleted", "Deleted a saved research item");
    return { itemId: parameters.itemId, deleted: true };
  },
});
