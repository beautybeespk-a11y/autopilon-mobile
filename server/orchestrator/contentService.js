import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { generateImage, editImage } from "../ai/imageProvider.js";
import { synthesizeSpeech } from "../ai/speech.js";
import { uploadFile, downloadFile } from "./fileService.js";
import { canAccessContent, readableContentClause } from "./contentPermissions.js";
import { enforceQuota, recordUsage } from "./billing.js";
import { enforceSpendLimit } from "./costControls.js";
import { recordVoiceUsage, TTS_CENTS_PER_CHAR } from "./voiceUsage.js";
import { publishEvent } from "../automation/triggers.js";

const now = () => new Date().toISOString();

export function getAsset(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM content_assets WHERE id = ?").get(id);
}

export function requireAssetAccess(userId, assetId, action) {
  const asset = getAsset(assetId);
  if (!asset) {
    const err = new Error("Content asset not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!canAccessContent(userId, asset, action)) {
    const err = new Error("You don't have permission to do that.");
    err.code = "FORBIDDEN";
    throw err;
  }
  return asset;
}

function withTags(asset) {
  if (!asset) return asset;
  return { ...asset, tags: JSON.parse(asset.tags || "[]") };
}

// The one gate every generation goes through before an actual provider call
// is made — reuses the EXISTING billing/quota functions (spec §25: "Do NOT
// create a separate billing path"). Soft quota, same as every other AI call
// in this codebase: never blocks, just tracked and warned on at thresholds.
function checkGenerationQuota(orgId, { agentId, userId } = {}) {
  enforceQuota(orgId, "maxAiRequests", "AI requests");
  enforceSpendLimit(orgId, { agentId, userId });
}

function recordGenerationUsage({ orgId, kind, costCents, agentId, userId }) {
  const scope = { agentId: agentId || null, userId: userId || null };
  recordUsage(orgId, "ai_request", 1, null, scope);
  const typeMap = { image: "image_generation", video: "video_generation", audio: "audio_generation", text: "content_text_generation" };
  const usageType = typeMap[kind];
  if (usageType) recordUsage(orgId, usageType, 1, { costCents }, { ...scope, costCents });
}

function insertAsset({ orgId, workspaceId, projectId, ownerId, creatorUserId, agentId, contentType, title, fileId, textContent, status, errorMessage }) {
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO content_assets (id, orgId, workspaceId, projectId, ownerId, creatorUserId, agentId, contentType, title, fileId, textContent, status, errorMessage, currentVersion, favorite, visibility, publishStatus, tags, trashedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'private', 'draft', '[]', NULL, ?, ?)`
  ).run(id, orgId || null, workspaceId || null, projectId || null, ownerId, creatorUserId, agentId || null, contentType, title, fileId || null, textContent || null, status, errorMessage || null, ts, ts);
  return id;
}

function insertGeneration({ assetId, version, contentType, provider, model, prompt, negativePrompt, parameters, status, errorMessage, fileId, textContent, estimatedCostCents, durationMs, creatorUserId, agentId }) {
  db.prepare(
    `INSERT INTO content_generations (id, assetId, version, contentType, provider, model, prompt, negativePrompt, parameters, status, errorMessage, fileId, textContent, estimatedCostCents, durationMs, creatorUserId, agentId, createdAt, completedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    cryptoRandom(), assetId, version, contentType, provider || null, model || null, prompt || null, negativePrompt || null,
    JSON.stringify(parameters || {}), status, errorMessage || null, fileId || null, textContent || null,
    estimatedCostCents || 0, durationMs || null, creatorUserId, agentId || null, now(), status === "ready" || status === "failed" ? now() : null
  );
}

// Records a visible failed text asset (e.g. copywriterService.generateCopy
// hitting PROVIDER_NOT_CONFIGURED) — same "failures are visible in history,
// never silently dropped" principle generateImageAsset already follows.
// Kept separate from createTextAsset() since a failed attempt never has
// completion text to store.
export function recordFailedTextGeneration({ userId, orgId, workspaceId, projectId, agentId, contentType, title, prompt, errorMessage }) {
  const assetId = insertAsset({
    orgId, workspaceId, projectId, ownerId: userId, creatorUserId: userId, agentId, contentType,
    title, status: "failed", errorMessage,
  });
  insertGeneration({ assetId, version: 1, contentType, prompt, parameters: {}, status: "failed", errorMessage, creatorUserId: userId, agentId });
  publishEvent(userId, "content", "content_generation_failed", { assetId, contentType, error: errorMessage });
  return assetId;
}

// Text content (captions, ad copy, blog posts, scripts...) — no File System
// involvement at all, since it's just text living on the asset row (see the
// design note in db.js). Used by copywriterService.js.
export function createTextAsset({ userId, orgId, workspaceId, projectId, agentId, contentType, title, textContent, provider, model, prompt }) {
  if (orgId) checkGenerationQuota(orgId, { agentId, userId });
  const assetId = insertAsset({
    orgId, workspaceId, projectId, ownerId: userId, creatorUserId: userId, agentId, contentType, title,
    fileId: null, textContent, status: "ready",
  });
  insertGeneration({ assetId, version: 1, contentType, provider, model, prompt, parameters: {}, status: "ready", textContent, creatorUserId: userId, agentId });
  if (orgId) recordGenerationUsage({ orgId, kind: "text", costCents: 0, agentId, userId });
  publishEvent(userId, "content", "content_generated", { assetId, contentType });
  return withTags(getAsset(assetId));
}

// Image generation — the real, End-to-end tested path. Each generated image
// becomes its own content_assets row (independently manageable/versionable),
// stored through the EXISTING File System (uploadFile()), never a second
// storage path.
export async function generateImageAsset({ userId, orgId, workspaceId, projectId, folderId, agentId, prompt, negativePrompt, provider, model, size, quality, numImages = 1, background, title }) {
  if (orgId) checkGenerationQuota(orgId, { agentId, userId });
  const start = Date.now();
  let result;
  try {
    result = await generateImage({ provider, model, prompt, size, quality, numImages, background });
  } catch (err) {
    // A single failed generation still gets a real asset row (status
    // 'failed') so it shows up in history/library rather than vanishing —
    // spec §16/§29 both expect failures to be visible, not silently dropped.
    const assetId = insertAsset({
      orgId, workspaceId, projectId, ownerId: userId, creatorUserId: userId, agentId,
      contentType: "image", title: title || prompt?.slice(0, 60) || "Untitled image",
      status: "failed", errorMessage: err.code === "PROVIDER_NOT_CONFIGURED" ? (err.detail || err.message) : "Image generation failed.",
    });
    insertGeneration({ assetId, version: 1, contentType: "image", provider, model, prompt, negativePrompt, parameters: { size, quality, numImages, background }, status: "failed", errorMessage: err.message, creatorUserId: userId, agentId, durationMs: Date.now() - start });
    publishEvent(userId, "content", "content_generation_failed", { assetId, contentType: "image", error: err.message });
    throw Object.assign(err, { assetId });
  }

  const durationMs = Date.now() - start;
  const costCentsEach = 4; // matches OPENAI_IMAGE_CAPABILITIES.estimatedCostCentsPerImage — see the note there on why this is an estimate, not a real quote
  const assets = [];
  for (const image of result.images) {
    const file = await uploadFile({
      userId, orgId, workspaceId, projectId, folderId,
      buffer: image.buffer, originalFilename: `${(title || "content-image").replace(/[^a-zA-Z0-9._-]/g, "_")}.png`, mimeType: "image/png",
      visibility: "private", agentId,
    });
    const assetId = insertAsset({
      orgId, workspaceId, projectId, ownerId: userId, creatorUserId: userId, agentId,
      contentType: "image", title: title || prompt?.slice(0, 60) || "Untitled image", fileId: file.id, status: "ready",
    });
    insertGeneration({
      assetId, version: 1, contentType: "image", provider: result.provider, model: result.model, prompt, negativePrompt,
      parameters: { size, quality, numImages, background }, status: "ready", fileId: file.id,
      estimatedCostCents: costCentsEach, durationMs, creatorUserId: userId, agentId,
    });
    if (orgId) recordGenerationUsage({ orgId, kind: "image", costCents: costCentsEach, agentId, userId });
    publishEvent(userId, "content", "content_generated", { assetId, contentType: "image", fileId: file.id });
    assets.push(withTags(getAsset(assetId)));
  }
  return assets;
}

// Regeneration/edit for an EXISTING image asset — creates a new version
// rather than overwriting, same non-destructive principle as
// fileVersions.js's restoreVersion().
export async function regenerateImageAsset(userId, assetId, { prompt, negativePrompt, provider, model, size, quality, background, useReferenceImage = true } = {}) {
  const asset = requireAssetAccess(userId, assetId, "manage");
  if (asset.contentType !== "image") {
    const err = new Error("Only image assets can be regenerated with this action.");
    err.code = "INVALID";
    throw err;
  }
  if (asset.orgId) checkGenerationQuota(asset.orgId, { agentId: asset.agentId, userId });

  const start = Date.now();
  const effectivePrompt = prompt || db.prepare("SELECT prompt FROM content_generations WHERE assetId = ? ORDER BY version DESC LIMIT 1").get(assetId)?.prompt;
  let result;
  try {
    if (useReferenceImage && asset.fileId) {
      const { buffer, file } = await downloadFile(userId, asset.fileId);
      result = await editImage({ provider, model, prompt: effectivePrompt, negativePrompt, imageBuffer: buffer, imageMimeType: file.mimeType, size, background });
    } else {
      result = await generateImage({ provider, model, prompt: effectivePrompt, negativePrompt, size, quality, background, numImages: 1 });
    }
  } catch (err) {
    const nextVersion = asset.currentVersion + 1;
    insertGeneration({ assetId, version: nextVersion, contentType: "image", provider, model, prompt: effectivePrompt, negativePrompt, parameters: { size, quality, background }, status: "failed", errorMessage: err.message, creatorUserId: userId, durationMs: Date.now() - start });
    publishEvent(userId, "content", "content_generation_failed", { assetId, contentType: "image", error: err.message });
    throw err;
  }

  const durationMs = Date.now() - start;
  const image = result.images[0];
  const file = await uploadFile({
    userId, orgId: asset.orgId, workspaceId: asset.workspaceId, projectId: asset.projectId, folderId: null,
    buffer: image.buffer, originalFilename: `${asset.title.replace(/[^a-zA-Z0-9._-]/g, "_")}.png`, mimeType: "image/png", visibility: "private",
  });
  const nextVersion = asset.currentVersion + 1;
  insertGeneration({
    assetId, version: nextVersion, contentType: "image", provider: result.provider, model: result.model, prompt: effectivePrompt, negativePrompt,
    parameters: { size, quality, background }, status: "ready", fileId: file.id, estimatedCostCents: 4, durationMs, creatorUserId: userId,
  });
  db.prepare("UPDATE content_assets SET fileId = ?, currentVersion = ?, status = 'ready', updatedAt = ? WHERE id = ?").run(file.id, nextVersion, now(), assetId);
  if (asset.orgId) recordGenerationUsage({ orgId: asset.orgId, kind: "image", costCents: 4, agentId: asset.agentId, userId });
  publishEvent(userId, "content", "content_generated", { assetId, contentType: "image", fileId: file.id, version: nextVersion });
  return withTags(getAsset(assetId));
}

// Voiceover generation — reuses the EXISTING Voice system (Phase 13's
// synthesizeSpeech/ai/speech.js) rather than a new audio provider, and
// records into the same voice_usage accounting a spoken chat reply uses
// (voiceUsage.js), per spec: "must integrate with the existing Voice
// system... all voice usage must pass through existing usage/billing."
// Storage still goes through the File System, same as image assets.
export async function generateVoiceoverAsset({ userId, orgId, workspaceId, projectId, folderId, agentId, text, provider, voice, speed, title }) {
  if (!text?.trim()) {
    const err = new Error("Voiceover text is required.");
    err.code = "INVALID";
    throw err;
  }
  if (orgId) checkGenerationQuota(orgId, { agentId, userId });
  const start = Date.now();
  let result;
  try {
    result = await synthesizeSpeech({ text, provider, voice, speed });
  } catch (err) {
    const assetId = insertAsset({
      orgId, workspaceId, projectId, ownerId: userId, creatorUserId: userId, agentId,
      contentType: "voiceover", title: title || text.slice(0, 60) || "Untitled voiceover",
      status: "failed", errorMessage: err.code === "PROVIDER_NOT_CONFIGURED" ? (err.detail || err.message) : "Voiceover generation failed.",
    });
    insertGeneration({ assetId, version: 1, contentType: "voiceover", provider, prompt: text, parameters: { voice, speed }, status: "failed", errorMessage: err.message, creatorUserId: userId, agentId, durationMs: Date.now() - start });
    publishEvent(userId, "content", "content_generation_failed", { assetId, contentType: "voiceover", error: err.message });
    throw Object.assign(err, { assetId });
  }

  const durationMs = Date.now() - start;
  const costCents = text.length * TTS_CENTS_PER_CHAR;
  const file = await uploadFile({
    userId, orgId, workspaceId, projectId, folderId,
    buffer: result.audio, originalFilename: `${(title || "voiceover").replace(/[^a-zA-Z0-9._-]/g, "_")}.mp3`, mimeType: result.mimeType || "audio/mpeg",
    visibility: "private", agentId,
  });
  const assetId = insertAsset({
    orgId, workspaceId, projectId, ownerId: userId, creatorUserId: userId, agentId,
    contentType: "voiceover", title: title || text.slice(0, 60) || "Untitled voiceover", fileId: file.id, status: "ready",
  });
  insertGeneration({
    assetId, version: 1, contentType: "voiceover", provider: result.provider, prompt: text,
    parameters: { voice, speed }, status: "ready", fileId: file.id, estimatedCostCents: costCents, durationMs, creatorUserId: userId, agentId,
  });
  recordVoiceUsage({ userId, kind: "tts", provider: result.provider, characters: text.length, estimatedCostCents: costCents, agentId });
  if (orgId) recordGenerationUsage({ orgId, kind: "audio", costCents, agentId, userId });
  publishEvent(userId, "content", "content_generated", { assetId, contentType: "voiceover", fileId: file.id });
  return withTags(getAsset(assetId));
}

// Records that a content asset was designated for a Meta campaign — a local
// reference only (see the linkedCampaignId column note in db.js). Called by
// meta/campaigns.js's create_campaign tool when a contentAssetId is passed;
// never called from anywhere that spends money or bypasses approval.
export function linkAssetToCampaign(userId, assetId, campaignId) {
  requireAssetAccess(userId, assetId, "manage");
  db.prepare("UPDATE content_assets SET linkedCampaignId = ?, updatedAt = ? WHERE id = ?").run(campaignId, now(), assetId);
  return withTags(getAsset(assetId));
}

export function listVersions(userId, assetId) {
  requireAssetAccess(userId, assetId, "view");
  return db.prepare("SELECT * FROM content_generations WHERE assetId = ? ORDER BY version DESC").all(assetId);
}

// Content Library search — permission-filtered at the SQL level, same
// principle as files.js's listFiles(): a user never even sees a row they
// can't access.
export function listAssets(userId, filters = {}) {
  const { q, contentType, projectId, workspaceId, orgId, agentId, favoritesOnly, publishedOnly, trashed = false, tag, limit = 100 } = filters;
  const { sql: accessSql, params: accessParams } = readableContentClause(userId);
  const clauses = [accessSql, trashed ? "trashedAt IS NOT NULL" : "trashedAt IS NULL"];
  const params = [...accessParams];

  if (contentType) { clauses.push("contentType = ?"); params.push(contentType); }
  if (projectId) { clauses.push("projectId = ?"); params.push(projectId); }
  if (workspaceId) { clauses.push("workspaceId = ?"); params.push(workspaceId); }
  if (orgId) { clauses.push("orgId = ?"); params.push(orgId); }
  if (agentId) { clauses.push("agentId = ?"); params.push(agentId); }
  if (favoritesOnly) clauses.push("favorite = 1");
  if (publishedOnly) clauses.push("publishStatus = 'published'");
  if (tag) { clauses.push("tags LIKE ?"); params.push(`%"${tag}"%`); }
  if (q) { clauses.push("(title LIKE ? OR textContent LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }

  const sql = `SELECT * FROM content_assets WHERE ${clauses.join(" AND ")} ORDER BY updatedAt DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map(withTags);
}

export function updateAsset(userId, assetId, patch) {
  requireAssetAccess(userId, assetId, "manage");
  const { title, tags, favorite, visibility, publishStatus, projectId } = patch;
  const sets = [];
  const params = [];
  if (title !== undefined) { sets.push("title = ?"); params.push(title); }
  if (tags !== undefined) { sets.push("tags = ?"); params.push(JSON.stringify(tags)); }
  if (favorite !== undefined) { sets.push("favorite = ?"); params.push(favorite ? 1 : 0); }
  if (visibility !== undefined) { sets.push("visibility = ?"); params.push(visibility); }
  if (publishStatus !== undefined) { sets.push("publishStatus = ?"); params.push(publishStatus); }
  if (projectId !== undefined) { sets.push("projectId = ?"); params.push(projectId || null); }
  sets.push("updatedAt = ?"); params.push(now());
  params.push(assetId);
  db.prepare(`UPDATE content_assets SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return withTags(getAsset(assetId));
}

export function duplicateAsset(userId, assetId) {
  const asset = requireAssetAccess(userId, assetId, "view");
  const newId = insertAsset({
    orgId: asset.orgId, workspaceId: asset.workspaceId, projectId: asset.projectId, ownerId: userId, creatorUserId: userId, agentId: asset.agentId,
    contentType: asset.contentType, title: `Copy of ${asset.title}`, fileId: asset.fileId, textContent: asset.textContent, status: asset.status,
  });
  const latestGen = db.prepare("SELECT * FROM content_generations WHERE assetId = ? ORDER BY version DESC LIMIT 1").get(assetId);
  if (latestGen) {
    insertGeneration({
      assetId: newId, version: 1, contentType: asset.contentType, provider: latestGen.provider, model: latestGen.model,
      prompt: latestGen.prompt, negativePrompt: latestGen.negativePrompt, parameters: JSON.parse(latestGen.parameters || "{}"),
      status: "ready", fileId: asset.fileId, textContent: asset.textContent, creatorUserId: userId,
    });
  }
  return withTags(getAsset(newId));
}

export function trashAsset(userId, assetId) {
  requireAssetAccess(userId, assetId, "delete");
  db.prepare("UPDATE content_assets SET trashedAt = ?, updatedAt = ? WHERE id = ?").run(now(), now(), assetId);
  return { assetId, trashed: true };
}

export function restoreAsset(userId, assetId) {
  requireAssetAccess(userId, assetId, "delete");
  db.prepare("UPDATE content_assets SET trashedAt = NULL, updatedAt = ? WHERE id = ?").run(now(), assetId);
  return withTags(getAsset(assetId));
}

// Deletes the DB rows only — the underlying file (if any) is NOT deleted
// here, since it's still owned/managed by the File System and may be
// referenced elsewhere; delete it from the File Manager directly if it
// should truly be gone. This keeps content_assets a thin index over files
// rather than a second thing with delete authority over the same bytes.
export function permanentlyDeleteAsset(userId, assetId) {
  requireAssetAccess(userId, assetId, "delete");
  db.prepare("DELETE FROM content_assets WHERE id = ?").run(assetId);
  return { assetId, permanentlyDeleted: true };
}
