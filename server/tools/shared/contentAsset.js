import db from "../../db.js";
import { requireFileAccess } from "../../orchestrator/fileService.js";
import { getStorageProvider } from "../../storage/provider.js";

// Turns a Content Studio image asset's id into real bytes a tool can upload
// somewhere (e.g. meta.create_image_ad's contentAssetId option) — used when
// the agent generates its own ad creative instead of using a photo the user
// attached or a URL. Access control is deliberately NOT re-derived here:
// content_assets doesn't carry its own org/workspace ACL, it just references
// a File System row, so requireFileAccess() on that fileId is the one real
// permission gate — same pattern conversationService.js's attachmentFileId
// handling already uses.
export async function resolveContentImageAsset(userId, assetId) {
  const asset = db.prepare("SELECT * FROM content_assets WHERE id = ?").get(assetId);
  if (!asset) {
    const err = new Error("That Content Studio asset wasn't found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (asset.contentType !== "image" || !asset.fileId) {
    const err = new Error("That Content Studio asset isn't a generated image.");
    err.code = "INVALID";
    throw err;
  }
  const file = requireFileAccess(userId, asset.fileId, "view");
  const buffer = await getStorageProvider(file.storageProvider).download({ key: file.storageKey });
  return { buffer, mimeType: file.mimeType || "image/png" };
}
