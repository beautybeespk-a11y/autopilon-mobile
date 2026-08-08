import db from "../db.js";
import { getTool } from "../tools/registry.js";

// Phase 2 default model: an agent grants every permission implied by its
// enabled skills' tools. agent_permissions (schema already present) allows
// per-agent overrides/restrictions in a later phase without a migration.
export function getAgentSkillIds(agentId) {
  if (!agentId) return [];
  const rows = db.prepare("SELECT skillId FROM agent_skills WHERE agentId = ?").all(agentId);
  return rows.map((r) => r.skillId);
}

export function getAgentPermissionOverrides(agentId) {
  if (!agentId) return null;
  const rows = db.prepare("SELECT permission FROM agent_permissions WHERE agentId = ?").all(agentId);
  return rows.length ? new Set(rows.map((r) => r.permission)) : null; // null = no explicit overrides
}

// Every authenticated user implicitly has these — they own their own data
// and there is no multi-tenant permission model yet.
const BASE_USER_PERMISSIONS = new Set([
  "tasks.read", "tasks.write", "memory.read", "memory.write", "memory.delete",
  "research.read", "research.write", "knowledge.read", "knowledge.write", "knowledge.delete",
  "meta.read", "meta.write", "meta.manage",
  "whatsapp.read", "whatsapp.write", "whatsapp.manage",
  "automation.read", "automation.write", "automation.execute", "automation.delete",
  "wordpress.read", "wordpress.write",
  "woocommerce.read", "woocommerce.manage",
  "gmail.read", "gmail.send",
  "calendar.read", "calendar.write",
  "drive.read", "drive.write",
  "docs.read", "docs.write",
  "sheets.read", "sheets.write",
  "shopify.read", "shopify.manage",
  "agent.delegate",
]);

export function checkPermission({ agentId, permission }) {
  if (!BASE_USER_PERMISSIONS.has(permission)) {
    return { allowed: false, reason: `Unknown permission "${permission}"` };
  }
  const overrides = getAgentPermissionOverrides(agentId);
  if (overrides && !overrides.has(permission)) {
    return { allowed: false, reason: `The selected agent is not granted "${permission}"` };
  }
  return { allowed: true };
}

// A tool is available to an agent only if: registered, the agent has the
// tool's skill enabled, and every required permission checks out. userId is
// needed to resolve a caller's own custom (Developer SDK) tools — optional
// and additive, every existing call site without one still works exactly
// as before for the ~140 static tools.
export function toolAvailableToAgent(toolName, agentId, userId) {
  const tool = getTool(toolName, userId);
  if (!tool) return { available: false, reason: `Tool "${toolName}" is not registered` };

  const skillIds = getAgentSkillIds(agentId);
  if (!skillIds.includes(tool.category)) {
    return { available: false, reason: `The selected agent does not have the "${tool.category}" skill enabled` };
  }

  for (const perm of tool.requiredPermissions) {
    const check = checkPermission({ agentId, permission: perm });
    if (!check.allowed) return { available: false, reason: check.reason };
  }

  return { available: true };
}
