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
    logActivity(db, req.session.userId, "integration_connection_failed", `WordPress connection failed: ${err.message}`, { req, result: "failure" });
    res.status(400).json({ error: "Could not verify this WordPress connection.", detail: err.message });
  }
});

// Phase 18.2 §3: WordPress application passwords DO have a real revoke
// endpoint (DELETE /wp-json/wp/v2/users/me/application-passwords/{uuid}),
// but only by UUID — and this integration only ever receives the raw
// password the user pastes in, generated ahead of time in their own WP
// admin. WordPress never re-exposes a password's UUID from the raw value
// after creation, so there's no reliable way to identify which of the
// user's application passwords to revoke without risking revoking the
// wrong one. Classified NOT SUPPORTED for this connect flow specifically
// (not a limitation of WordPress's API in general) — the user revokes it
// themselves in Users -> Profile -> Application Passwords. `revoked: null`
// is the honest answer; local credentials are always still fully deleted
// below.
router.post("/disconnect", (req, res) => {
  disconnectIntegration(req.session.userId, "wordpress");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected WordPress");
  res.json({ ok: true, revoked: null, revocationError: null });
});

export default router;
