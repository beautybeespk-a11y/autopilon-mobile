import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { apiRateLimit, apiAiConcurrencyLimit } from "./rateLimit.js";
import { apiError, apiErrorFromException } from "./errors.js";
import { generateOrgText, generateOrgImage, generateOrgVoice, getOrgAsset } from "../orchestrator/contentApiService.js";

const router = Router();
router.use(requireApiKey, apiRateLimit());
const aiConcurrency = apiAiConcurrencyLimit();

router.get("/:id", requireScope("content:generate"), (req, res) => {
  const asset = getOrgAsset(req.orgId, req.params.id);
  if (!asset) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested content asset was not found.");
  res.json(asset);
});

router.post("/text", requireScope("content:generate"), aiConcurrency, async (req, res) => {
  const { contentType, brief } = req.body || {};
  if (!contentType || !brief?.trim()) return apiError(res, 400, "INVALID_REQUEST", "contentType and brief are required.");
  try {
    res.status(201).json(await generateOrgText(req.orgId, req.apiKey.userId, req.body));
  } catch (err) {
    apiErrorFromException(res, err, "Text generation failed.");
  }
});

router.post("/image", requireScope("content:generate"), aiConcurrency, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt?.trim()) return apiError(res, 400, "INVALID_REQUEST", "prompt is required.");
  try {
    res.status(201).json(await generateOrgImage(req.orgId, req.apiKey.userId, req.body));
  } catch (err) {
    apiErrorFromException(res, err, "Image generation failed.");
  }
});

router.post("/voice", requireScope("content:generate"), aiConcurrency, async (req, res) => {
  const { text } = req.body || {};
  if (!text?.trim()) return apiError(res, 400, "INVALID_REQUEST", "text is required.");
  try {
    res.status(201).json(await generateOrgVoice(req.orgId, req.apiKey.userId, req.body));
  } catch (err) {
    apiErrorFromException(res, err, "Voice generation failed.");
  }
});

export default router;
