// Modular Tool Registry. Tools register themselves here; nothing else in the
// app (chat route, orchestrator) executes tool logic directly — they all go
// through this registry so future tools slot in without touching existing code.

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

export function getTool(name) {
  return tools.get(name) || null;
}

export function listTools() {
  return Array.from(tools.values());
}

// Tools available to a given set of enabled skill ids (an agent's skills).
export function listToolsForSkills(skillIds = []) {
  const set = new Set(skillIds);
  return listTools().filter((t) => set.has(t.category));
}

export function toolRequiresConfirmation(name) {
  return Boolean(getTool(name)?.requiresConfirmation);
}

export function toolRequiredPermissions(name) {
  return getTool(name)?.requiredPermissions || [];
}

// Basic structural validation against the tool's declared parameter schema.
// Not a full JSON-schema validator — just required-field + type presence
// checks, which is enough to catch the AI producing malformed calls.
export function validateParameters(name, parameters) {
  const tool = getTool(name);
  if (!tool) return { valid: false, error: `Unknown tool "${name}"` };
  const schema = tool.parameters || { properties: {}, required: [] };
  const required = schema.required || [];
  const missing = required.filter((key) => parameters?.[key] === undefined || parameters?.[key] === null || parameters?.[key] === "");
  if (missing.length) return { valid: false, error: `Missing required parameter(s): ${missing.join(", ")}` };
  return { valid: true };
}
