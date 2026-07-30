import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { saveConnection, disconnectIntegration, getConnection } from "../integrations/manager.js";
import { checkStore } from "../integrations/shopify/api.js";

const router = Router();
router.use(requireAuth);

router.get("/status", async (req, res) => {
  const conn = getConnection(req.session.userId, "shopify");
  if (!conn || conn.status !== "connected") return res.json({ connected: false });
  const meta = JSON.parse(conn.meta || "{}");
  try {
    const info = await checkStore(meta.shopDomain, conn.accessToken);
    res.json({ connected: true, shopDomain: meta.shopDomain, ...info });
  } catch (err) {
    res.json({ connected: false, reason: err.message });
  }
});

router.post("/connect", async (req, res) => {
  const { shopDomain, accessToken } = req.body || {};
  if (!shopDomain || !accessToken) {
    return res.status(400).json({ error: "shopDomain and accessToken are required." });
  }
  try {
    const info = await checkStore(shopDomain, accessToken);
    saveConnection(req.session.userId, "shopify", {
      accessToken,
      expiresAt: null,
      scopes: [],
      meta: { shopDomain: shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "") },
    });
    logActivity(db, req.session.userId, "integration_connected", "Connected Shopify");
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(400).json({ error: "Could not verify this Shopify connection.", detail: err.message });
  }
});

router.post("/disconnect", (req, res) => {
  disconnectIntegration(req.session.userId, "shopify");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected Shopify");
  res.json({ ok: true });
});

export default router;
