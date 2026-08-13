import { Router } from "express";
import { requireAuth, logActivity } from "../middleware.js";
import db from "../db.js";
import { imageProviderStatus, listImageProviderOptions } from "../ai/imageProvider.js";
import { videoProviderStatus, listVideoProviderOptions } from "../ai/videoProvider.js";
import { audioProviderStatus, listAudioProviderOptions } from "../ai/audioProvider.js";
import {
  generateImageAsset, regenerateImageAsset, generateVoiceoverAsset, listAssets, requireAssetAccess,
  updateAsset, duplicateAsset, trashAsset, restoreAsset, permanentlyDeleteAsset, listVersions, linkAssetToCampaign,
} from "../orchestrator/contentService.js";
import { generateCopy, listCopyTypes } from "../orchestrator/copywriterService.js";
import { listBrands, getBrand, createBrand, updateBrand, deleteBrand } from "../orchestrator/brandService.js";
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, applyTemplate } from "../orchestrator/templateService.js";
import { aiRateLimit, aiConcurrencyLimit } from "../orchestrator/rateLimiter.js";

const router = Router();
router.use(requireAuth);
const aiLimiter = aiRateLimit();
const aiConcurrency = aiConcurrencyLimit();

const ERROR_STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, INVALID: 400, QUOTA_EXCEEDED: 403, UNSUPPORTED: 501 };

function handleError(res, err, fallback) {
  console.error("[content]", err);
  if (err.code === "PROVIDER_NOT_CONFIGURED") {
    return res.status(503).json({ error: "This generation provider isn't configured yet.", detail: err.detail || err.message, assetId: err.assetId });
  }
  const status = ERROR_STATUS[err.code] || 500;
  res.status(status).json({ error: status === 500 ? fallback : err.message });
}

router.get("/status", (req, res) => {
  res.json({
    image: { default: imageProviderStatus(), options: listImageProviderOptions() },
    video: { default: videoProviderStatus(), options: listVideoProviderOptions() },
    audio: { default: audioProviderStatus(), options: listAudioProviderOptions() },
  });
});

router.get("/copy-types", (req, res) => res.json(listCopyTypes()));

// --- Brand voice & Templates — literal paths, must be registered BEFORE
// the generic "/:id" routes below, or Express would match "/brands" and
// "/templates" as an :id value instead (same ordering rule already
// followed elsewhere in this codebase, e.g. automations "new" vs ":id"). ---

router.get("/brands", (req, res) => res.json(listBrands(req.session.userId, { orgId: req.query.orgId })));
router.get("/brands/:id", (req, res) => {
  const brand = getBrand(req.session.userId, req.params.id);
  if (!brand) return res.status(404).json({ error: "Brand voice not found." });
  res.json(brand);
});
router.post("/brands", (req, res) => {
  try {
    res.json(createBrand(req.session.userId, req.body || {}));
  } catch (err) { handleError(res, err, "Couldn't create brand voice."); }
});
router.patch("/brands/:id", (req, res) => {
  try {
    res.json(updateBrand(req.session.userId, req.params.id, req.body || {}));
  } catch (err) { handleError(res, err, "Couldn't update brand voice."); }
});
router.delete("/brands/:id", (req, res) => {
  try {
    deleteBrand(req.session.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err, "Couldn't delete brand voice."); }
});

router.get("/templates", (req, res) => {
  res.json(listTemplates({ userId: req.session.userId, orgId: req.query.orgId, contentType: req.query.contentType }));
});
router.post("/templates", (req, res) => {
  try {
    res.json(createTemplate(req.session.userId, req.body || {}));
  } catch (err) { handleError(res, err, "Couldn't create template."); }
});
router.patch("/templates/:id", (req, res) => {
  try {
    res.json(updateTemplate(req.session.userId, req.params.id, req.body || {}));
  } catch (err) { handleError(res, err, "Couldn't update template."); }
});
router.delete("/templates/:id", (req, res) => {
  try {
    deleteTemplate(req.session.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) { handleError(res, err, "Couldn't delete template."); }
});

// --- Generation — "/generate/*" is also a literal prefix, safe before "/:id". ---

router.post("/generate/image", aiLimiter, aiConcurrency, async (req, res) => {
  try {
    const { prompt, negativePrompt, provider, model, size, quality, numImages, background, orgId, workspaceId, projectId, folderId, agentId, title } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: "A prompt is required." });
    const assets = await generateImageAsset({
      userId: req.session.userId, orgId, workspaceId, projectId, folderId, agentId,
      prompt, negativePrompt, provider, model, size, quality, numImages, background, title,
    });
    logActivity(db, req.session.userId, "content_generated", `Generated ${assets.length} image(s): "${title || prompt.slice(0, 40)}"`, { orgId, workspaceId, req });
    res.json({ assets });
  } catch (err) { handleError(res, err, "Image generation failed."); }
});

router.post("/generate/voiceover", aiLimiter, aiConcurrency, async (req, res) => {
  try {
    const { text, voice, speed, provider, orgId, workspaceId, projectId, folderId, agentId, title } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: "text is required." });
    const asset = await generateVoiceoverAsset({
      userId: req.session.userId, orgId, workspaceId, projectId, folderId, agentId, text, provider, voice, speed, title,
    });
    logActivity(db, req.session.userId, "content_generated", `Generated voiceover: "${asset.title}"`, { orgId, workspaceId, req });
    res.json(asset);
  } catch (err) { handleError(res, err, "Voiceover generation failed."); }
});

router.post("/generate/copy", aiLimiter, aiConcurrency, async (req, res) => {
  try {
    const { contentType, brief, brandId, tone, targetAudience, keywords, orgId, workspaceId, projectId, agentId, title, templateId, templateVariables } = req.body || {};
    let effectiveBrief = brief;
    if (templateId) {
      const template = getTemplate(req.session.userId, templateId);
      if (!template) return res.status(404).json({ error: "Template not found." });
      effectiveBrief = applyTemplate(template, templateVariables || {});
    }
    if (!contentType) return res.status(400).json({ error: "contentType is required." });
    if (!effectiveBrief?.trim()) return res.status(400).json({ error: "A brief (or a template) is required." });
    const asset = await generateCopy({
      userId: req.session.userId, orgId, workspaceId, projectId, agentId, contentType,
      brief: effectiveBrief, brandId, tone, targetAudience, keywords, title,
    });
    logActivity(db, req.session.userId, "content_generated", `Generated ${contentType}: "${asset.title}"`, { orgId, workspaceId, req });
    res.json(asset);
  } catch (err) { handleError(res, err, "Copy generation failed."); }
});

// --- Library ---

router.get("/", (req, res) => {
  const { q, contentType, projectId, workspaceId, orgId, agentId, favoritesOnly, publishedOnly, trashed, tag, limit } = req.query;
  const assets = listAssets(req.session.userId, {
    q: q || undefined, contentType: contentType || undefined, projectId: projectId || undefined,
    workspaceId: workspaceId || undefined, orgId: orgId || undefined, agentId: agentId || undefined,
    favoritesOnly: favoritesOnly === "true", publishedOnly: publishedOnly === "true", trashed: trashed === "true",
    tag: tag || undefined, limit: limit ? Number(limit) : undefined,
  });
  res.json(assets);
});

// --- Individual asset — generic "/:id" routes come LAST. ---

router.post("/:id/regenerate", async (req, res) => {
  try {
    const { prompt, negativePrompt, provider, model, size, quality, background, useReferenceImage } = req.body || {};
    const asset = await regenerateImageAsset(req.session.userId, req.params.id, { prompt, negativePrompt, provider, model, size, quality, background, useReferenceImage });
    res.json(asset);
  } catch (err) { handleError(res, err, "Regeneration failed."); }
});

router.post("/:id/link-campaign", (req, res) => {
  try {
    const { campaignId } = req.body || {};
    if (!campaignId) return res.status(400).json({ error: "campaignId is required." });
    res.json(linkAssetToCampaign(req.session.userId, req.params.id, campaignId));
  } catch (err) { handleError(res, err, "Couldn't link content to campaign."); }
});

router.post("/:id/duplicate", (req, res) => {
  try {
    res.json(duplicateAsset(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't duplicate content."); }
});

router.post("/:id/restore", (req, res) => {
  try {
    res.json(restoreAsset(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't restore content."); }
});

router.delete("/:id/permanent", (req, res) => {
  try {
    res.json(permanentlyDeleteAsset(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't permanently delete content."); }
});

router.get("/:id/versions", (req, res) => {
  try {
    res.json(listVersions(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't load version history."); }
});

router.get("/:id", (req, res) => {
  try {
    res.json(requireAssetAccess(req.session.userId, req.params.id, "view"));
  } catch (err) { handleError(res, err, "Couldn't load content."); }
});

router.patch("/:id", (req, res) => {
  try {
    res.json(updateAsset(req.session.userId, req.params.id, req.body || {}));
  } catch (err) { handleError(res, err, "Couldn't update content."); }
});

router.delete("/:id", (req, res) => {
  try {
    res.json(trashAsset(req.session.userId, req.params.id));
  } catch (err) { handleError(res, err, "Couldn't delete content."); }
});

export default router;
