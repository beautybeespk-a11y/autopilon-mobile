import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { installAsset, listMyInstalls, updateInstall, rollbackInstall, setInstallEnabled, uninstall } from "../orchestrator/marketplaceInstalls.js";

const router = Router();
router.use(requireAuth);

router.post("/assets/:id/install", (req, res) => {
  try {
    const result = installAsset(req.session.userId, req.params.id);
    logActivity(db, req.session.userId, "marketplace_asset_installed", `Installed a marketplace asset`);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/installs", (req, res) => res.json(listMyInstalls(req.session.userId)));

router.post("/installs/:id/update", (req, res) => {
  try {
    const result = updateInstall(req.session.userId, req.params.id);
    logActivity(db, req.session.userId, "marketplace_install_updated", `Updated an installed asset to v${result.updatedTo}`);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/installs/:id/rollback", (req, res) => {
  const { versionId } = req.body || {};
  if (!versionId) return res.status(400).json({ error: "versionId is required." });
  try {
    const result = rollbackInstall(req.session.userId, req.params.id, versionId);
    logActivity(db, req.session.userId, "marketplace_install_rolled_back", `Rolled back an installed asset to v${result.rolledBackTo}`);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/installs/:id/enable", (req, res) => {
  try { res.json(setInstallEnabled(req.session.userId, req.params.id, true)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/installs/:id/disable", (req, res) => {
  try { res.json(setInstallEnabled(req.session.userId, req.params.id, false)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete("/installs/:id", (req, res) => {
  try {
    const result = uninstall(req.session.userId, req.params.id);
    logActivity(db, req.session.userId, "marketplace_asset_uninstalled", `Uninstalled a marketplace asset`);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
