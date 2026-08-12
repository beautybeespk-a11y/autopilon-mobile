import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getMembership } from "./rbac.js";

const now = () => new Date().toISOString();

function withArrays(brand) {
  if (!brand) return brand;
  return { ...brand, preferredWords: JSON.parse(brand.preferredWords || "[]"), avoidWords: JSON.parse(brand.avoidWords || "[]") };
}

function canAccessBrand(userId, brand) {
  if (!brand) return false;
  if (brand.ownerId === userId) return true;
  // Org-scoped brand voices are readable by any member — a brand voice is
  // reference material for writing on the org's behalf, not a private
  // document; only the owner (or an org admin, via update/delete below)
  // can change it.
  if (brand.orgId) return Boolean(getMembership(brand.orgId, userId));
  return false;
}

function canManageBrand(userId, brand) {
  if (!brand) return false;
  if (brand.ownerId === userId) return true;
  if (brand.orgId) {
    const membership = getMembership(brand.orgId, userId);
    return Boolean(membership && ["owner", "admin"].includes(membership.role));
  }
  return false;
}

export function getBrand(userId, id) {
  const brand = db.prepare("SELECT * FROM content_brands WHERE id = ?").get(id);
  if (!brand || !canAccessBrand(userId, brand)) return null;
  return withArrays(brand);
}

export function listBrands(userId, { orgId } = {}) {
  const rows = orgId
    ? db.prepare("SELECT * FROM content_brands WHERE orgId = ? ORDER BY name ASC").all(orgId)
    : db.prepare("SELECT * FROM content_brands WHERE ownerId = ? AND orgId IS NULL ORDER BY name ASC").all(userId);
  return rows.filter((b) => canAccessBrand(userId, b)).map(withArrays);
}

export function createBrand(userId, { orgId, name, description, tone, writingStyle, targetAudience, preferredWords, avoidWords, ctaStyle, guidelines }) {
  if (orgId) {
    const membership = getMembership(orgId, userId);
    if (!membership || !["owner", "admin", "manager"].includes(membership.role)) {
      const err = new Error("You don't have permission to create a brand voice for this organization.");
      err.code = "FORBIDDEN";
      throw err;
    }
  }
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO content_brands (id, orgId, ownerId, name, description, tone, writingStyle, targetAudience, preferredWords, avoidWords, ctaStyle, guidelines, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId || null, userId, name, description || null, tone || null, writingStyle || null, targetAudience || null,
    JSON.stringify(preferredWords || []), JSON.stringify(avoidWords || []), ctaStyle || null, guidelines || null, ts, ts);
  return withArrays(db.prepare("SELECT * FROM content_brands WHERE id = ?").get(id));
}

export function updateBrand(userId, id, patch) {
  const brand = db.prepare("SELECT * FROM content_brands WHERE id = ?").get(id);
  if (!brand) {
    const err = new Error("Brand voice not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!canManageBrand(userId, brand)) {
    const err = new Error("You don't have permission to edit this brand voice.");
    err.code = "FORBIDDEN";
    throw err;
  }
  const fields = ["name", "description", "tone", "writingStyle", "targetAudience", "ctaStyle", "guidelines"];
  const sets = [];
  const params = [];
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = ?`); params.push(patch[f]); }
  }
  if (patch.preferredWords !== undefined) { sets.push("preferredWords = ?"); params.push(JSON.stringify(patch.preferredWords)); }
  if (patch.avoidWords !== undefined) { sets.push("avoidWords = ?"); params.push(JSON.stringify(patch.avoidWords)); }
  sets.push("updatedAt = ?"); params.push(now());
  params.push(id);
  db.prepare(`UPDATE content_brands SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return withArrays(db.prepare("SELECT * FROM content_brands WHERE id = ?").get(id));
}

export function deleteBrand(userId, id) {
  const brand = db.prepare("SELECT * FROM content_brands WHERE id = ?").get(id);
  if (!brand) return;
  if (!canManageBrand(userId, brand)) {
    const err = new Error("You don't have permission to delete this brand voice.");
    err.code = "FORBIDDEN";
    throw err;
  }
  db.prepare("DELETE FROM content_brands WHERE id = ?").run(id);
}
