import { resolveDeep } from "./templating.js";

// A condition step's config: { groups: [[{ field, op, value }, ...], ...] }
// Groups are OR'd together; conditions within a group are AND'd — matches
// the spec's "multiple AND/OR groups" requirement without a full expression
// parser.
function evalOne({ field, op, value }, variables) {
  const actual = resolveDeep(field, variables);
  const expected = resolveDeep(value, variables);
  switch (op) {
    case "equals": return String(actual) === String(expected);
    case "not_equals": return String(actual) !== String(expected);
    case "contains": return String(actual ?? "").includes(String(expected ?? ""));
    case "starts_with": return String(actual ?? "").startsWith(String(expected ?? ""));
    case "ends_with": return String(actual ?? "").endsWith(String(expected ?? ""));
    case "regex": {
      try { return new RegExp(String(expected)).test(String(actual ?? "")); }
      catch { return false; } // an invalid regex never matches, never crashes the filter
    }
    case "greater_than": return Number(actual) > Number(expected);
    case "less_than": return Number(actual) < Number(expected);
    case "exists": return actual !== undefined && actual !== null;
    case "empty": return actual === undefined || actual === null || actual === "";
    default: return false;
  }
}

export function evaluateConditionGroups(groups, variables) {
  if (!Array.isArray(groups) || groups.length === 0) return true;
  return groups.some((group) => (Array.isArray(group) ? group : [group]).every((cond) => evalOne(cond, variables)));
}
