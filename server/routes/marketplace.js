import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import {
  listCategories, listAssets, getAsset, listMyAssets, createAsset,
  publishFromAgent, publishFromAutomation, publishKnowledgePack,
  updateAssetListing, publishNewVersion, setAssetStatus, deleteAsset, listAssetVersions,
  getCreatorDashboard,
} from "../orchestrator/marketplace.js";
import { createReport } from "../orchestrator/marketplaceModeration.js";

const router = Router();
router.use(requireAuth);

router.get("/categories", (req, res) => res.json(listCategories()));

router.get("/assets", (req, res) => {
  const { q, type, category, sort, limit } = req.query;
  res.json(listAssets(req.session.userId, { query: q, assetType: type, categoryId: category, sort, limit: Number(limit) || 30 }));
});

router.get("/my-assets", (req, res) => res.json(listMyAssets(req.session.userId)));

router.get("/creator-dashboard", (req, res) => res.json(getCreatorDashboard(req.session.userId)));

router.post("/assets/:id/report", (req, res) => {
  const { reason, details } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ error: "reason is required." });
  try {
    const result = createReport(req.session.userId, req.params.id, reason, details);
    logActivity(db, req.session.userId, "marketplace_asset_reported", `Reported a marketplace asset: ${reason}`);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get("/assets/:id", (req, res) => {
  const asset = getAsset(req.session.userId, req.params.id);
  if (!asset) return res.status(404).json({ error: "Asset not found." });
  res.json(asset);
});

router.get("/assets/:id/versions", (req, res) => {
  try { res.json(listAssetVersions(req.session.userId, req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.post("/assets", (req, res) => {
  try {
    const asset = createAsset(req.session.userId, req.body || {});
    logActivity(db, req.session.userId, "marketplace_asset_created", `Created marketplace draft "${asset.name}"`);
    res.json(asset);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/assets/from-agent/:agentId", (req, res) => {
  try {
    const asset = publishFromAgent(req.session.userId, req.params.agentId, req.body || {});
    logActivity(db, req.session.userId, "marketplace_asset_created", `Created marketplace listing from agent: "${asset.name}"`);
    res.json(asset);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/assets/from-automation/:automationId", (req, res) => {
  try {
    const asset = publishFromAutomation(req.session.userId, req.params.automationId, req.body || {});
    logActivity(db, req.session.userId, "marketplace_asset_created", `Created marketplace listing from automation: "${asset.name}"`);
    res.json(asset);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/assets/knowledge-pack", (req, res) => {
  const { itemIds, ...listingFields } = req.body || {};
  try {
    const asset = publishKnowledgePack(req.session.userId, itemIds, listingFields);
    logActivity(db, req.session.userId, "marketplace_asset_created", `Created knowledge pack: "${asset.name}"`);
    res.json(asset);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/assets/:id", (req, res) => {
  try { res.json(updateAssetListing(req.session.userId, req.params.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/assets/:id/versions", (req, res) => {
  try {
    const asset = publishNewVersion(req.session.userId, req.params.id, req.body || {});
    logActivity(db, req.session.userId, "marketplace_version_published", `Published a new version of "${asset.name}"`);
    res.json(asset);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/assets/:id/publish", (req, res) => {
  try {
    const asset = setAssetStatus(req.session.userId, req.params.id, "published");
    logActivity(db, req.session.userId, "marketplace_asset_published", `Published "${asset.name}" to the marketplace`);
    res.json(asset);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/assets/:id/unpublish", (req, res) => {
  try { res.json(setAssetStatus(req.session.userId, req.params.id, "unpublished")); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete("/assets/:id", (req, res) => {
  try { res.json(deleteAsset(req.session.userId, req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

export default router;
