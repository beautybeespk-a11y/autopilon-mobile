import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createNotification } from "./notifications.js";

const now = () => new Date().toISOString();

export function listPendingAssets() {
  return db.prepare(
    `SELECT ma.*, u.name AS creatorName FROM marketplace_assets ma JOIN users u ON u.id = ma.creatorUserId
     WHERE ma.moderationStatus = 'pending' ORDER BY ma.updatedAt ASC`
  ).all();
}

function setModeration(assetId, moderationStatus, note) {
  const asset = db.prepare("SELECT creatorUserId, name FROM marketplace_assets WHERE id = ?").get(assetId);
  if (!asset) throw new Error("Asset not found.");
  db.prepare("UPDATE marketplace_assets SET moderationStatus = ?, moderationNote = ?, updatedAt = ? WHERE id = ?")
    .run(moderationStatus, note || null, now(), assetId);
  return asset;
}

export function approveAsset(assetId) {
  const asset = setModeration(assetId, "approved", null);
  createNotification(asset.creatorUserId, { type: "asset_approved", title: `"${asset.name}" is now live`, body: "Your listing was approved and is visible in the Marketplace.", link: `/app/marketplace/${assetId}` });
  return { moderationStatus: "approved" };
}

export function rejectAsset(assetId, reason) {
  const asset = setModeration(assetId, "rejected", reason);
  createNotification(asset.creatorUserId, { type: "asset_rejected", title: `"${asset.name}" was not approved`, body: reason || "No reason given.", link: `/app/marketplace/${assetId}` });
  return { moderationStatus: "rejected" };
}

// Suspension is for something that WAS live and needs to come down (unlike
// reject, which is for something that never got approved in the first
// place) — same moderationStatus field, different starting point and intent.
export function suspendAsset(assetId, reason) {
  const asset = setModeration(assetId, "suspended", reason);
  createNotification(asset.creatorUserId, { type: "asset_suspended", title: `"${asset.name}" has been suspended`, body: reason || "No reason given.", link: `/app/marketplace/${assetId}` });
  return { moderationStatus: "suspended" };
}

// --- Abuse reports ---
export function createReport(reporterUserId, assetId, reason, details) {
  const asset = db.prepare("SELECT id FROM marketplace_assets WHERE id = ?").get(assetId);
  if (!asset) throw new Error("Asset not found.");
  const id = cryptoRandom();
  db.prepare("INSERT INTO asset_reports (id, assetId, reporterUserId, reason, details, status, createdAt) VALUES (?, ?, ?, ?, ?, 'open', ?)")
    .run(id, assetId, reporterUserId, reason, details || null, now());
  return { id };
}

export function listOpenReports() {
  return db.prepare(
    `SELECT ar.*, ma.name AS assetName, u.name AS reporterName FROM asset_reports ar
     JOIN marketplace_assets ma ON ma.id = ar.assetId JOIN users u ON u.id = ar.reporterUserId
     WHERE ar.status = 'open' ORDER BY ar.createdAt ASC`
  ).all();
}

export function resolveReport(adminUserId, reportId, action) {
  if (!["resolved", "dismissed"].includes(action)) throw new Error("action must be 'resolved' or 'dismissed'.");
  const r = db.prepare("UPDATE asset_reports SET status = ?, resolvedBy = ?, resolvedAt = ? WHERE id = ?").run(action, adminUserId, now(), reportId);
  if (!r.changes) throw new Error("Report not found.");
  return { status: action };
}

// --- Category management ---
export function createCategory(name, description) {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  db.prepare("INSERT INTO marketplace_categories (id, name, slug, description, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(slug, name, slug, description || null, now());
  return { id: slug };
}

export function updateCategory(id, fields) {
  const { name, description } = fields;
  const r = db.prepare("UPDATE marketplace_categories SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?").run(name, description, id);
  if (!r.changes) throw new Error("Category not found.");
  return { id };
}

export function deleteCategory(id) {
  db.prepare("UPDATE marketplace_assets SET categoryId = NULL WHERE categoryId = ?").run(id); // don't orphan-delete assets, just uncategorize them
  const r = db.prepare("DELETE FROM marketplace_categories WHERE id = ?").run(id);
  if (!r.changes) throw new Error("Category not found.");
  return { deleted: true };
}
