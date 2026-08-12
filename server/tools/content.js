// Automation/agent tools for the AI Content Studio. Every one of these goes
// through the exact same tool executor lifecycle (planning -> confirmation
// if required -> running -> completed/failed) as every other tool, and every
// call ultimately runs through contentService.js/copywriterService.js — the
// same generation path, permission checks, and quota/billing gates a human
// clicking around the Content Studio UI would hit. Generation tools that
// spend real provider money (image, voiceover) are requiresConfirmation:
// true, same principle as create_campaign/resume_campaign in meta/campaigns.js.
import { registerTool } from "./registry.js";
import {
  generateImageAsset, regenerateImageAsset, generateVoiceoverAsset,
  listAssets, requireAssetAccess,
} from "../orchestrator/contentService.js";
import { generateCopy, listCopyTypes } from "../orchestrator/copywriterService.js";

registerTool({
  name: "generate_image",
  description: "Generates an AI image from a text prompt and saves it to the Content Library (uses the existing File System for storage). Costs real provider spend — requires confirmation.",
  category: "content_studio",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to generate" },
      size: { type: "string", description: "e.g. 1024x1024, 1536x1024, 1024x1536" },
      numImages: { type: "number", description: "How many images to generate (default 1)" },
      title: { type: "string" },
      projectId: { type: "string", description: "Attach the resulting asset(s) to this project" },
    },
    required: ["prompt"],
  },
  requiredPermissions: ["content_studio"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const assets = await generateImageAsset({
      userId: context.userId, agentId: context.agentId, projectId: parameters.projectId,
      prompt: parameters.prompt, size: parameters.size, numImages: parameters.numImages, title: parameters.title,
    });
    return { assets: assets.map((a) => ({ id: a.id, title: a.title, fileId: a.fileId, status: a.status })) };
  },
});

registerTool({
  name: "regenerate_image",
  description: "Regenerates an existing image asset with a new/adjusted prompt, creating a new version (the original stays in version history). Costs real provider spend — requires confirmation.",
  category: "content_studio",
  parameters: {
    type: "object",
    properties: {
      assetId: { type: "string" },
      prompt: { type: "string", description: "New prompt; omit to reuse the asset's last prompt" },
    },
    required: ["assetId"],
  },
  requiredPermissions: ["content_studio"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const asset = await regenerateImageAsset(context.userId, parameters.assetId, { prompt: parameters.prompt });
    return { id: asset.id, title: asset.title, fileId: asset.fileId, version: asset.currentVersion, status: asset.status };
  },
});

registerTool({
  name: "write_copy",
  description: `Generates marketing copy with AI (no image/video cost). contentType must be one of: ${listCopyTypes().map((t) => t.id).join(", ")}.`,
  category: "content_studio",
  parameters: {
    type: "object",
    properties: {
      contentType: { type: "string", description: listCopyTypes().map((t) => `${t.id} (${t.label})`).join("; ") },
      brief: { type: "string", description: "What to write about" },
      brandId: { type: "string", description: "Optional brand voice to write in" },
      tone: { type: "string" },
      targetAudience: { type: "string" },
      title: { type: "string" },
    },
    required: ["contentType", "brief"],
  },
  requiredPermissions: ["content_studio"],
  async execute(parameters, context) {
    const asset = await generateCopy({
      userId: context.userId, agentId: context.agentId, contentType: parameters.contentType,
      brief: parameters.brief, brandId: parameters.brandId, tone: parameters.tone,
      targetAudience: parameters.targetAudience, title: parameters.title,
    });
    return { id: asset.id, title: asset.title, contentType: asset.contentType, text: asset.textContent };
  },
});

registerTool({
  name: "generate_voiceover",
  description: "Converts text into a spoken voiceover audio asset using the platform's existing Voice/TTS system, and saves it to the Content Library. Costs real provider spend — requires confirmation.",
  category: "content_studio",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      voice: { type: "string", description: "e.g. alloy, echo, fable, onyx, nova, shimmer" },
      title: { type: "string" },
    },
    required: ["text"],
  },
  requiredPermissions: ["content_studio"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const asset = await generateVoiceoverAsset({
      userId: context.userId, agentId: context.agentId, text: parameters.text, voice: parameters.voice, title: parameters.title,
    });
    return { id: asset.id, title: asset.title, fileId: asset.fileId, status: asset.status };
  },
});

registerTool({
  name: "find_content",
  description: "Searches the Content Library by title/text, content type, project, or favorites.",
  category: "content_studio",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      contentType: { type: "string" },
      projectId: { type: "string" },
      favoritesOnly: { type: "boolean" },
    },
    required: [],
  },
  requiredPermissions: ["content_studio"],
  async execute(parameters, context) {
    const assets = listAssets(context.userId, {
      q: parameters.query, contentType: parameters.contentType, projectId: parameters.projectId, favoritesOnly: parameters.favoritesOnly,
    });
    return {
      assets: assets.map((a) => ({ id: a.id, title: a.title, contentType: a.contentType, status: a.status, fileId: a.fileId, favorite: Boolean(a.favorite) })),
      count: assets.length,
    };
  },
});

registerTool({
  name: "get_content_asset",
  description: "Returns full details for one Content Studio asset, including its text content if it's a text asset.",
  category: "content_studio",
  parameters: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"] },
  requiredPermissions: ["content_studio"],
  async execute(parameters, context) {
    return requireAssetAccess(context.userId, parameters.assetId, "view");
  },
});
