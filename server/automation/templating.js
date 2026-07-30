// Replaces {{variableName}} tokens with values from the run's variable
// state. Deliberately simple (no expressions, no nested paths beyond dot
// access) — enough for "use the campaign ID from step 2" without building a
// templating language.

function getPath(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function resolveTemplate(value, variables) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path) => {
    const resolved = getPath(variables, path);
    return resolved === undefined ? match : String(resolved);
  });
}

// Recursively resolves templates through an object/array of parameters.
export function resolveDeep(value, variables) {
  if (typeof value === "string") return resolveTemplate(value, variables);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, variables));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, variables);
    return out;
  }
  return value;
}
