// Content Generation service for the Public API (Phase 17 §12). Every
// generation call here passes straight through to the EXISTING generation
// functions (copywriterService.generateCopy, contentService.generateImageAsset/
// generateVoiceoverAsset) with orgId fixed to req.orgId — those functions
// already call enforceQuota/enforceSpendLimit/recordAiTextUsage internally
// (Task 38), so quota, spend limits, usage, and billing apply automatically
// with no separate cost-control logic here. This file's only job is the
// org-scoped wrapping and asset lookup, same discipline as every other
// Public API service this phase.
import { generateCopy } from "./copywriterService.js";
import { generateImageAsset, generateVoiceoverAsset, getAsset } from "./contentService.js";

function toPublicAssetShape(asset) {
  if (!asset) return null;
  return {
    id: asset.id, contentType: asset.contentType, title: asset.title,
    textContent: asset.textContent,
    // Media types (image/voiceover/etc.) store a reference into the
    // centralized File System, not a direct URL — fetch bytes via
    // GET /v1/files/:fileId/content (Task 47) or mint a signed link via
    // POST /v1/files/:fileId/download-url, same composition the web app uses.
    fileId: asset.fileId, status: asset.status, createdAt: asset.createdAt,
  };
}

export async function generateOrgText(orgId, userId, { contentType, brief, tone, targetAudience, keywords, title, agentId }) {
  const asset = await generateCopy({ userId, orgId, contentType, brief, tone, targetAudience, keywords, title, agentId });
  return toPublicAssetShape(asset);
}

export async function generateOrgImage(orgId, userId, { prompt, negativePrompt, size, quality, numImages, title, agentId }) {
  const assets = await generateImageAsset({ userId, orgId, prompt, negativePrompt, size, quality, numImages, title, agentId });
  return (Array.isArray(assets) ? assets : [assets]).map(toPublicAssetShape);
}

export async function generateOrgVoice(orgId, userId, { text, voice, speed, title, agentId }) {
  const asset = await generateVoiceoverAsset({ userId, orgId, text, voice, speed, title, agentId });
  return toPublicAssetShape(asset);
}

export function getOrgAsset(orgId, assetId) {
  const asset = getAsset(assetId);
  if (!asset || asset.orgId !== orgId) return null;
  return toPublicAssetShape(asset);
}
