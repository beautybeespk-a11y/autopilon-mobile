import db from "../db.js";
import { getMembership } from "./rbac.js";

// SQL fragment + params for "knowledge items this user can currently read,"
// covering three cases: their own items (existing Phase 8 agent-level rule
// still applies on top of this, handled separately in the tool), items
// shared 'organization'-wide with an org they belong to, items shared
// 'workspace'-wide with a workspace they belong to, and anything 'public'.
export function readableKnowledgeClause(userId) {
  const orgIds = db.prepare("SELECT orgId FROM organization_members WHERE userId = ? AND status = 'active'").all(userId).map((r) => r.orgId);
  const workspaceIds = db.prepare("SELECT workspaceId FROM workspace_members WHERE userId = ?").all(userId).map((r) => r.workspaceId);

  const clauses = ["userId = ?"];
  const params = [userId];

  clauses.push("crossUserVisibility = 'public'");

  if (orgIds.length) {
    clauses.push(`(crossUserVisibility = 'organization' AND orgId IN (${orgIds.map(() => "?").join(",")}))`);
    params.push(...orgIds);
  }
  if (workspaceIds.length) {
    clauses.push(`(crossUserVisibility = 'workspace' AND workspaceId IN (${workspaceIds.map(() => "?").join(",")}))`);
    params.push(...workspaceIds);
  }
  return { sql: `(${clauses.join(" OR ")})`, params };
}

export function canReadKnowledgeItem(userId, row) {
  if (row.userId === userId) return true;
  if (row.crossUserVisibility === "public") return true;
  if (row.crossUserVisibility === "organization" && row.orgId) return Boolean(getMembership(row.orgId, userId));
  if (row.crossUserVisibility === "workspace" && row.workspaceId) {
    return Boolean(db.prepare("SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(row.workspaceId, userId));
  }
  return false;
}

export function canWriteKnowledgeItem(userId, row) {
  if (row.userId === userId) return true; // agent-level `editable`/ownership within one's own items is checked separately
  if (row.crossUserEditable !== "editable") return false;
  return canReadKnowledgeItem(userId, row);
}

// Delete is intentionally not grantable just by being shared as editable —
// same principle as Phase 8's memory/knowledge sharing: sharing means read
// (and optionally edit) access, never delete rights, unless you're an
// owner/admin of the organization it belongs to.
export function canDeleteKnowledgeItem(userId, row) {
  if (row.userId === userId) return true;
  if (row.orgId) {
    const membership = getMembership(row.orgId, userId);
    return Boolean(membership && ["owner", "admin"].includes(membership.role));
  }
  return false;
}

// Changing an item's sharing settings is its own permission tier — same
// bar as delete (owner, or org owner/admin), since it controls who else
// gains access.
export const canShareKnowledgeItem = canDeleteKnowledgeItem;
