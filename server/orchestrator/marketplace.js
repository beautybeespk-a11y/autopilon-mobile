import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getSellerRevenue } from "./marketplacePayments.js";

const now = () => new Date().toISOString();
const ASSET_TYPES = ["agent", "automation", "prompt", "knowledge_pack"];

function slugify(name) {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  let slug = base || cryptoRandom();
  let i = 2;
  while (db.prepare("SELECT 1 FROM marketplace_assets WHERE slug = ?").get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

export function listCategories() {
  return db.prepare("SELECT * FROM marketplace_categories ORDER BY name").all();
}

function attachLatestVersion(asset) {
  const version = db.prepare("SELECT * FROM asset_versions WHERE assetId = ? ORDER BY createdAt DESC LIMIT 1").get(asset.id);
  return { ...asset, tags: JSON.parse(asset.tags || "[]"), latestVersion: version ? { ...version, manifest: JSON.parse(version.manifest) } : null };
}

// Batched equivalent of attachLatestVersion for list views (listAssets,
// listMyAssets) — one query for every row's latest version instead of one
// query per row, and skips the (sometimes large) manifest JSON blob that
// only the single-asset detail view (getAsset -> attachLatestVersion)
// actually renders.
function attachLatestVersionsBatch(assets) {
  if (assets.length === 0) return [];
  const placeholders = assets.map(() => "?").join(",");
  const versionRows = db.prepare(
    `SELECT id, assetId, version, releaseNotes, createdAt FROM (
       SELECT id, assetId, version, releaseNotes, createdAt,
              ROW_NUMBER() OVER (PARTITION BY assetId ORDER BY createdAt DESC) AS rn
       FROM asset_versions WHERE assetId IN (${placeholders})
     ) WHERE rn = 1`
  ).all(...assets.map((a) => a.id));
  const byAsset = new Map(versionRows.map((v) => [v.assetId, v]));
  return assets.map((asset) => ({ ...asset, tags: JSON.parse(asset.tags || "[]"), latestVersion: byAsset.get(asset.id) || null }));
}

// Public browse/search — published + public only, unless the viewer is the
// asset's own creator (who should see their unlisted/private/draft work too).
export function listAssets(viewerUserId, { query, assetType, categoryId, sort = "recent", limit = 30 } = {}) {
  const clauses = ["(status = 'published' AND moderationStatus = 'approved' AND visibility != 'private')"];
  const params = [];
  if (viewerUserId) { clauses[0] = `(${clauses[0]} OR creatorUserId = ?)`; params.push(viewerUserId); }
  if (query) { clauses.push("(name LIKE ? OR description LIKE ? OR tags LIKE ?)"); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  if (assetType) { clauses.push("assetType = ?"); params.push(assetType); }
  if (categoryId) { clauses.push("categoryId = ?"); params.push(categoryId); }

  const orderBy = {
    recent: "createdAt DESC",
    popular: "downloadCount DESC",
    top_rated: "(CASE WHEN ratingCount > 0 THEN CAST(ratingSum AS REAL) / ratingCount ELSE 0 END) DESC",
    trending: "updatedAt DESC", // no real time-decay trending calc yet — approximated by recent activity
  }[sort] || "createdAt DESC";

  const rows = db.prepare(
    `SELECT * FROM marketplace_assets WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`
  ).all(...params, limit);
  return attachLatestVersionsBatch(rows);
}

export function getAsset(viewerUserId, assetId) {
  const asset = db.prepare("SELECT * FROM marketplace_assets WHERE id = ?").get(assetId);
  if (!asset) return null;
  const isOwner = asset.creatorUserId === viewerUserId;
  if (!isOwner && (asset.status !== "published" || asset.moderationStatus !== "approved" || asset.visibility === "private")) return null;
  return attachLatestVersion(asset);
}

export function listMyAssets(userId) {
  const rows = db.prepare("SELECT * FROM marketplace_assets WHERE creatorUserId = ? ORDER BY updatedAt DESC").all(userId);
  return attachLatestVersionsBatch(rows);
}

function createAssetWithVersion(creatorUserId, { assetType, name, description, categoryId, tags, pricingType, priceCents, license, visibility, manifest, releaseNotes }) {
  if (!ASSET_TYPES.includes(assetType)) throw new Error(`Unknown asset type "${assetType}". Supported: ${ASSET_TYPES.join(", ")}.`);
  if (!name?.trim()) throw new Error("Asset name is required.");
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO marketplace_assets
     (id, creatorUserId, assetType, name, slug, description, categoryId, tags, pricingType, priceCents, license, visibility, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  ).run(
    id, creatorUserId, assetType, name, slugify(name), description || "", categoryId || null,
    JSON.stringify(tags || []), pricingType || "free", priceCents || 0, license || null, visibility || "public", ts, ts
  );
  const versionId = cryptoRandom();
  db.prepare("INSERT INTO asset_versions (id, assetId, version, releaseNotes, manifest, createdAt) VALUES (?, ?, '1.0.0', ?, ?, ?)")
    .run(versionId, id, releaseNotes || "Initial release", JSON.stringify(manifest), ts);
  db.prepare("UPDATE marketplace_assets SET currentVersionId = ? WHERE id = ?").run(versionId, id);
  return getAsset(creatorUserId, id);
}

export function createAsset(userId, fields) {
  return createAssetWithVersion(userId, fields);
}

// --- Publish-from-existing helpers — snapshot a real agent/automation's
// config into a manifest, rather than asking the creator to redescribe it
// from scratch. Reuses the existing tables directly (no duplicated shape
// logic) instead of going through agentManager/automation engine, since
// this only needs to READ the config, not create a live agent/automation. ---

export function publishFromAgent(userId, agentId, listingFields) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ? AND userId = ?").get(agentId, userId);
  if (!agent) throw new Error("Agent not found, or you don't own it.");
  const skillIds = db.prepare("SELECT skillId FROM agent_skills WHERE agentId = ?").all(agentId).map((r) => r.skillId);
  const manifest = {
    instructions: agent.instructions, personality: agent.personality, category: agent.category,
    aiProvider: agent.aiProvider, aiModel: agent.aiModel, skillIds,
    requiredSkills: skillIds, // what an installer needs enabled for this to work as intended
  };
  return createAssetWithVersion(userId, { ...listingFields, assetType: "agent", manifest, name: listingFields.name || agent.name });
}

export function publishFromAutomation(userId, automationId, listingFields) {
  const automation = db.prepare("SELECT * FROM automations WHERE id = ? AND userId = ?").get(automationId, userId);
  if (!automation) throw new Error("Automation not found, or you don't own it.");
  const steps = db.prepare("SELECT type, config, stepOrder FROM automation_steps WHERE automationId = ? ORDER BY stepOrder ASC").all(automationId)
    .map((s) => ({ type: s.type, config: JSON.parse(s.config || "{}") }));
  const manifest = {
    triggerType: automation.triggerType,
    triggerConfig: JSON.parse(automation.triggerConfig || "{}"),
    variables: JSON.parse(automation.variables || "{}"),
    steps,
  };
  return createAssetWithVersion(userId, { ...listingFields, assetType: "automation", manifest, name: listingFields.name || automation.name });
}

export function publishKnowledgePack(userId, itemIds, listingFields) {
  if (!itemIds?.length) throw new Error("Select at least one knowledge item to include.");
  const placeholders = itemIds.map(() => "?").join(",");
  const items = db.prepare(`SELECT title, category, tags, content FROM knowledge_items WHERE id IN (${placeholders}) AND userId = ?`).all(...itemIds, userId);
  if (!items.length) throw new Error("None of the selected knowledge items belong to you.");
  const manifest = { items: items.map((i) => ({ title: i.title, category: i.category, tags: JSON.parse(i.tags || "[]"), content: JSON.parse(i.content || "null") })) };
  return createAssetWithVersion(userId, { ...listingFields, assetType: "knowledge_pack", manifest });
}

export function updateAssetListing(userId, assetId, fields) {
  const asset = db.prepare("SELECT * FROM marketplace_assets WHERE id = ? AND creatorUserId = ?").get(assetId, userId);
  if (!asset) throw new Error("Asset not found, or you don't own it.");
  const { name, description, categoryId, tags, pricingType, priceCents, license, visibility } = fields;
  db.prepare(
    `UPDATE marketplace_assets SET
       name = COALESCE(?, name), description = COALESCE(?, description), categoryId = COALESCE(?, categoryId),
       tags = COALESCE(?, tags), pricingType = COALESCE(?, pricingType), priceCents = COALESCE(?, priceCents),
       license = COALESCE(?, license), visibility = COALESCE(?, visibility), updatedAt = ?
     WHERE id = ?`
  ).run(name, description, categoryId, tags ? JSON.stringify(tags) : null, pricingType, priceCents, license, visibility, now(), assetId);
  return getAsset(userId, assetId);
}

export function publishNewVersion(userId, assetId, { version, releaseNotes, manifest }) {
  const asset = db.prepare("SELECT * FROM marketplace_assets WHERE id = ? AND creatorUserId = ?").get(assetId, userId);
  if (!asset) throw new Error("Asset not found, or you don't own it.");
  if (!version?.trim()) throw new Error("A version string is required (e.g. '1.1.0').");
  const versionId = cryptoRandom();
  db.prepare("INSERT INTO asset_versions (id, assetId, version, releaseNotes, manifest, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(versionId, assetId, version, releaseNotes || null, JSON.stringify(manifest), now());
  db.prepare("UPDATE marketplace_assets SET currentVersionId = ?, updatedAt = ? WHERE id = ?").run(versionId, now(), assetId);
  return getAsset(userId, assetId);
}

export function setAssetStatus(userId, assetId, status) {
  if (!["draft", "published", "unpublished"].includes(status)) throw new Error("Invalid status.");
  let moderationSql = "";
  const params = [status];
  if (status === "published") {
    const isAdmin = db.prepare("SELECT isPlatformAdmin FROM users WHERE id = ?").get(userId)?.isPlatformAdmin;
    moderationSql = ", moderationStatus = ?";
    params.push(isAdmin ? "approved" : "pending");
  }
  params.push(now(), assetId, userId);
  const r = db.prepare(`UPDATE marketplace_assets SET status = ?${moderationSql}, updatedAt = ? WHERE id = ? AND creatorUserId = ?`).run(...params);
  if (!r.changes) throw new Error("Asset not found, or you don't own it.");
  return getAsset(userId, assetId);
}

export function deleteAsset(userId, assetId) {
  const r = db.prepare("DELETE FROM marketplace_assets WHERE id = ? AND creatorUserId = ?").run(assetId, userId);
  if (!r.changes) throw new Error("Asset not found, or you don't own it.");
  return { deleted: true };
}

export function listAssetVersions(userId, assetId) {
  const asset = getAsset(userId, assetId);
  if (!asset) throw new Error("Asset not found.");
  return db.prepare("SELECT id, version, releaseNotes, createdAt FROM asset_versions WHERE assetId = ? ORDER BY createdAt DESC").all(assetId);
}

// Creator Dashboard. Revenue now comes from real asset_purchases rows —
// Payments exists as of this addition, so paymentsEnabled reflects that
// honestly (it was `false` before this was built, deliberately, rather
// than showing a misleading $0).
export function getCreatorDashboard(userId) {
  const assets = db.prepare("SELECT * FROM marketplace_assets WHERE creatorUserId = ? ORDER BY updatedAt DESC").all(userId);

  const totals = {
    totalAssets: assets.length,
    publishedCount: assets.filter((a) => a.status === "published").length,
    draftCount: assets.filter((a) => a.status === "draft").length,
    totalDownloads: assets.reduce((sum, a) => sum + a.downloadCount, 0),
    totalReviews: assets.reduce((sum, a) => sum + a.ratingCount, 0),
  };
  const ratingSum = assets.reduce((sum, a) => sum + a.ratingSum, 0);
  totals.avgRating = totals.totalReviews > 0 ? Math.round((ratingSum / totals.totalReviews) * 10) / 10 : null;

  const assetIds = assets.map((a) => a.id);
  const recentReviews = assetIds.length
    ? db.prepare(
        `SELECT ar.id, ar.rating, ar.reviewText, ar.createdAt, ar.developerReply, ma.id AS assetId, ma.name AS assetName, u.name AS reviewerName
         FROM asset_reviews ar JOIN marketplace_assets ma ON ma.id = ar.assetId JOIN users u ON u.id = ar.userId
         WHERE ar.assetId IN (${assetIds.map(() => "?").join(",")})
         ORDER BY ar.createdAt DESC LIMIT 10`
      ).all(...assetIds)
    : [];

  const perAsset = assets.map((a) => ({
    id: a.id, name: a.name, assetType: a.assetType, status: a.status,
    downloadCount: a.downloadCount, ratingCount: a.ratingCount,
    avgRating: a.ratingCount > 0 ? Math.round((a.ratingSum / a.ratingCount) * 10) / 10 : null,
  }));

  const revenue = getSellerRevenue(userId);
  return { ...totals, paymentsEnabled: true, revenue, assets: perAsset, recentReviews };
}
