import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getMembership } from "./rbac.js";

const now = () => new Date().toISOString();

function withConfig(t) {
  return t ? { ...t, config: JSON.parse(t.config || "{}") } : t;
}

// Platform seed templates (isPlatform=1) are visible to everyone; an org's
// own custom templates are visible to its members; a personal template
// (orgId NULL, real ownerId) is visible only to its creator.
export function listTemplates({ userId, orgId, contentType }) {
  let sql = "SELECT * FROM content_templates WHERE (isPlatform = 1";
  const params = [];
  if (orgId) { sql += " OR orgId = ?"; params.push(orgId); }
  sql += " OR ownerId = ?)"; params.push(userId);
  if (contentType) { sql += " AND contentType = ?"; params.push(contentType); }
  sql += " ORDER BY isPlatform DESC, name ASC";
  return db.prepare(sql).all(...params).map(withConfig);
}

export function getTemplate(id) {
  return withConfig(db.prepare("SELECT * FROM content_templates WHERE id = ?").get(id));
}

export function createTemplate(userId, { orgId, name, description, contentType, category, promptTemplate, config }) {
  if (orgId) {
    const membership = getMembership(orgId, userId);
    if (!membership) {
      const err = new Error("You're not a member of this organization.");
      err.code = "FORBIDDEN";
      throw err;
    }
  }
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO content_templates (id, orgId, ownerId, name, description, contentType, category, promptTemplate, config, isPlatform, marketplaceAssetId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
  ).run(id, orgId || null, userId, name, description || null, contentType, category || null, promptTemplate, JSON.stringify(config || {}), ts, ts);
  return getTemplate(id);
}

export function updateTemplate(userId, id, patch) {
  const template = db.prepare("SELECT * FROM content_templates WHERE id = ?").get(id);
  if (!template) {
    const err = new Error("Template not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (template.isPlatform || template.ownerId !== userId) {
    const err = new Error("You don't have permission to edit this template.");
    err.code = "FORBIDDEN";
    throw err;
  }
  const fields = ["name", "description", "category", "promptTemplate"];
  const sets = [];
  const params = [];
  for (const f of fields) if (patch[f] !== undefined) { sets.push(`${f} = ?`); params.push(patch[f]); }
  if (patch.config !== undefined) { sets.push("config = ?"); params.push(JSON.stringify(patch.config)); }
  sets.push("updatedAt = ?"); params.push(now());
  params.push(id);
  db.prepare(`UPDATE content_templates SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getTemplate(id);
}

export function deleteTemplate(userId, id) {
  const template = db.prepare("SELECT * FROM content_templates WHERE id = ?").get(id);
  if (!template) return;
  if (template.isPlatform || template.ownerId !== userId) {
    const err = new Error("You don't have permission to delete this template.");
    err.code = "FORBIDDEN";
    throw err;
  }
  db.prepare("DELETE FROM content_templates WHERE id = ?").run(id);
}

// {{placeholder}} substitution — deliberately simple (no conditionals/loops)
// since templates here are prompt scaffolding, not a general template
// engine; automation/templating.js's richer engine solves a different
// problem (workflow variable interpolation) and isn't a fit to reuse here.
export function applyTemplate(template, variables = {}) {
  return template.promptTemplate.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (variables[key] !== undefined ? String(variables[key]) : match));
}
