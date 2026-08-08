// Modular Tool Registry. Tools register themselves here; nothing else in the
// app (chat route, orchestrator) executes tool logic directly — they all go
// through this registry so future tools slot in without touching existing code.

import db from "../db.js";
import { callCustomToolWebhook } from "../orchestrator/customTools.js";

const tools = new Map();

/**
 * @param {object} tool
 * @param {string} tool.name
 * @param {string} tool.description
 * @param {string} tool.category           // maps to a skill id, e.g. "productivity", "memory"
 * @param {object} tool.parameters         // JSON-schema-like shape, for the AI + validation
 * @param {string[]} tool.requiredPermissions
 * @param {boolean} tool.requiresConfirmation
 * @param {(parameters: object, context: object) => Promise<object>} tool.execute
 */
export function registerTool(tool) {
  if (!tool?.name) throw new Error("Tool must have a name");
  if (typeof tool.execute !== "function") throw new Error(`Tool "${tool.name}" must have an execute function`);
  tools.set(tool.name, {
    requiredPermissions: [],
    requiresConfirmation: false,
    parameters: { type: "object", properties: {}, required: [] },
    ...tool,
  });
}

// Wraps a custom_tools DB row as a first-class tool object — same shape
// every static tool has, so nothing downstream (executor.js, the system
// prompt builder) needs to know the difference. execute() just calls the
// developer's webhook instead of running local code.
function toRegistryShape(row) {
  return {
    name: row.name,
    description: row.description,
    category: "custom_tools",
    parameters: JSON.parse(row.parametersSchema),
    requiredPermissions: [],
    requiresConfirmation: Boolean(row.requiresConfirmation),
    isCustom: true,
    async execute(parameters, context) {
      return callCustomToolWebhook(row, parameters, context);
    },
  };
}

// Custom tools are scoped to their OWN creator only — a user's published
// tools become available to their own agents once they enable the "Custom
// Tools" skill; they are never automatically shared with other accounts'
// agents (that would mean strangers' agents silently calling a webhook
// they don't control or trust).
function getCustomTool(name, userId) {
  if (!userId || !name.startsWith("custom.")) return null;
  const row = db.prepare("SELECT * FROM custom_tools WHERE name = ? AND creatorUserId = ? AND status = 'published'").get(name, userId);
  return row ? toRegistryShape(row) : null;
}

export function getTool(name, userId) {
  return tools.get(name) || getCustomTool(name, userId) || null;
}

export function listTools() {
  return Array.from(tools.values());
}

// Tools available to a given set of enabled skill ids (an agent's skills).
// userId is optional and additive — every existing call site that doesn't
// pass one keeps getting exactly the static tool list it always has.
export function listToolsForSkills(skillIds = [], userId) {
  const set = new Set(skillIds);
  const staticTools = listTools().filter((t) => set.has(t.category));
  if (!userId || !set.has("custom_tools")) return staticTools;
  const customRows = db.prepare("SELECT * FROM custom_tools WHERE creatorUserId = ? AND status = 'published'").all(userId);
  return [...staticTools, ...customRows.map(toRegistryShape)];
}

export function toolRequiresConfirmation(name, userId) {
  return Boolean(getTool(name, userId)?.requiresConfirmation);
}

export function toolRequiredPermissions(name, userId) {
  return getTool(name, userId)?.requiredPermissions || [];
}

// Basic structural validation against the tool's declared parameter schema.
// Not a full JSON-schema validator — just required-field + type presence
// checks, which is enough to catch the AI producing malformed calls.
export function validateParameters(name, parameters, userId) {
  const tool = getTool(name, userId);
  if (!tool) return { valid: false, error: `Unknown tool "${name}"` };
  const schema = tool.parameters || { properties: {}, required: [] };
  const required = schema.required || [];
  const missing = required.filter((key) => parameters?.[key] === undefined || parameters?.[key] === null || parameters?.[key] === "");
  if (missing.length) return { valid: false, error: `Missing required parameter(s): ${missing.join(", ")}` };
  return { valid: true };
}
