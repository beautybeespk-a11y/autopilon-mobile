import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { saveConnection, disconnectIntegration, getConnection } from "../integrations/manager.js";
import { checkStore } from "../integrations/woocommerce/api.js";

const router = Router();
router.use(requireAuth);

router.get("/status", async (req, res) => {
  const conn = getConnection(req.session.userId, "woocommerce");
  if (!conn || conn.status !== "connected") return res.json({ connected: false });
  const meta = JSON.parse(conn.meta || "{}");
  try {
    const info = await checkStore(meta.siteUrl, meta.consumerKey, conn.accessToken);
    res.json({ connected: true, siteUrl: meta.siteUrl, ...info });
  } catch (err) {
    res.json({ connected: false, reason: err.message });
  }
});

router.post("/connect", async (req, res) => {
  const { siteUrl, consumerKey, consumerSecret } = req.body || {};
  if (!siteUrl || !consumerKey || !consumerSecret) {
    return res.status(400).json({ error: "siteUrl, consumerKey, and consumerSecret are required." });
  }
  try {
    const info = await checkStore(siteUrl, consumerKey, consumerSecret);
    saveConnection(req.session.userId, "woocommerce", {
      accessToken: consumerSecret,
      expiresAt: null,
      scopes: [],
      meta: { siteUrl, consumerKey },
    });
    logActivity(db, req.session.userId, "integration_connected", "Connected WooCommerce");
    res.json({ ok: true, ...info });
  } catch (err) {
    logActivity(db, req.session.userId, "integration_connection_failed", `WooCommerce connection failed: ${err.message}`, { req, result: "failure" });
    res.status(400).json({ error: "Could not verify this WooCommerce connection.", detail: err.message });
  }
});

// Phase 18.2 §3: WooCommerce's consumer key/secret pair has no
// programmatic revoke call — only the store owner can delete the REST API
// key, in their WooCommerce admin (Settings -> Advanced -> REST API).
// `revoked: null` is the honest answer; local credentials are always
// still fully deleted below.
router.post("/disconnect", (req, res) => {
  disconnectIntegration(req.session.userId, "woocommerce");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected WooCommerce");
  res.json({ ok: true, revoked: null, revocationError: null });
});

export default router;
