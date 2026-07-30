import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { saveConnection, disconnectIntegration, getConnection } from "../integrations/manager.js";
import { checkSite } from "../integrations/wordpress/api.js";

const router = Router();
router.use(requireAuth);

router.get("/status", async (req, res) => {
  const conn = getConnection(req.session.userId, "wordpress");
  if (!conn || conn.status !== "connected") return res.json({ connected: false });
  const meta = JSON.parse(conn.meta || "{}");
  try {
    const info = await checkSite(meta.siteUrl, meta.username, conn.accessToken);
    res.json({ connected: true, siteUrl: meta.siteUrl, username: meta.username, siteName: info.name });
  } catch (err) {
    res.json({ connected: false, reason: err.message });
  }
});

router.post("/connect", async (req, res) => {
  const { siteUrl, username, appPassword } = req.body || {};
  if (!siteUrl || !username || !appPassword) {
    return res.status(400).json({ error: "siteUrl, username, and appPassword are required." });
  }
  try {
    const info = await checkSite(siteUrl, username, appPassword);
    saveConnection(req.session.userId, "wordpress", {
      accessToken: appPassword, // the "application password" itself — WordPress's own long-lived credential
      expiresAt: null,
      scopes: [],
      meta: { siteUrl, username, siteName: info.name },
    });
    logActivity(db, req.session.userId, "integration_connected", "Connected WordPress");
    res.json({ ok: true, siteName: info.name });
  } catch (err) {
    res.status(400).json({ error: "Could not verify this WordPress connection.", detail: err.message });
  }
});

router.post("/disconnect", (req, res) => {
  disconnectIntegration(req.session.userId, "wordpress");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected WordPress");
  res.json({ ok: true });
});

export default router;
