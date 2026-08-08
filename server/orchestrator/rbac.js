import db from "../db.js";

// The permission categories from the Phase 9 spec — used both for built-in
// role mapping and for custom roles (a custom role's `permissions` column
// is just a JSON array drawn from this same set).
export const PERMISSIONS = [
  "agent_management", "automation", "integrations", "billing", "knowledge",
  "tasks", "workflows", "marketplace", "api_keys", "reports", "settings",
  "member_management",
];

// Built-in roles map to fixed permission sets — not stored in the DB, since
// they never change. Custom roles (in `custom_roles`) are the only ones
// that need persistence.
const BUILTIN_ROLE_PERMISSIONS = {
  owner: [...PERMISSIONS], // everything, including billing/settings/member_management
  admin: PERMISSIONS.filter((p) => p !== "billing"),
  manager: ["agent_management", "automation", "integrations", "knowledge", "tasks", "workflows", "reports"],
  member: ["agent_management", "knowledge", "tasks", "workflows"],
  viewer: ["reports", "knowledge"],
};
const BUILTIN_ROLES = Object.keys(BUILTIN_ROLE_PERMISSIONS);

export function isBuiltinRole(role) {
  return BUILTIN_ROLES.includes(role);
}

export function getRolePermissions(orgId, role) {
  if (isBuiltinRole(role)) return BUILTIN_ROLE_PERMISSIONS[role];
  const custom = db.prepare("SELECT permissions FROM custom_roles WHERE id = ? AND orgId = ?").get(role, orgId);
  return custom ? JSON.parse(custom.permissions) : [];
}

export function listRoles(orgId) {
  const builtins = BUILTIN_ROLES.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), builtin: true, permissions: BUILTIN_ROLE_PERMISSIONS[id] }));
  const custom = db.prepare("SELECT id, name, permissions, createdAt FROM custom_roles WHERE orgId = ?").all(orgId)
    .map((r) => ({ ...r, builtin: false, permissions: JSON.parse(r.permissions) }));
  return [...builtins, ...custom];
}

// The single membership lookup every permission check and route guard goes
// through — one place that defines "is this user actually in this org, and
// with what role/status."
export function getMembership(orgId, userId) {
  return db.prepare(
    "SELECT * FROM organization_members WHERE orgId = ? AND userId = ? AND status = 'active'"
  ).get(orgId, userId);
}

export function hasPermission(orgId, userId, permission) {
  const membership = getMembership(orgId, userId);
  if (!membership) return false;
  return getRolePermissions(orgId, membership.role).includes(permission);
}

// Express middleware factory. Expects the organization id to be resolvable
// from the request — pass a function to extract it (usually req.params.id
// or req.params.orgId), since routes mount this differently depending on
// whether the org id is the resource itself or a parent of it.
export function requireOrgPermission(permission, getOrgId = (req) => req.params.orgId || req.params.id) {
  return (req, res, next) => {
    const orgId = getOrgId(req);
    if (!orgId) return res.status(400).json({ error: "Organization id is required." });
    const membership = getMembership(orgId, req.session.userId);
    if (!membership) return res.status(403).json({ error: "You're not a member of this organization." });
    if (!getRolePermissions(orgId, membership.role).includes(permission)) {
      return res.status(403).json({ error: `Your role ("${membership.role}") doesn't have "${permission}" permission.` });
    }
    req.orgMembership = membership;
    next();
  };
}
