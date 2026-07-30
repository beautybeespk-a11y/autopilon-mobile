import { Router } from "express";
import { requireAuth, cryptoRandom, logActivity } from "../middleware.js";
import db from "../db.js";
import { buildAuthorizationUrl, exchangeCodeForToken, googleOAuthStatus } from "../integrations/google/oauth.js";
import { saveConnection, disconnectIntegration, connectionHealth } from "../integrations/manager.js";

// One factory, four routers (google_calendar / google_drive / google_docs /
// google_sheets) — same connect/callback/disconnect shape as gmailAuth.js,
// just parameterized by service id + display label instead of copy-pasted
// four times.
export function createGoogleServiceRouter(service, label) {
  const router = Router();
  const stateKey = `googleOAuthState_${service}`;

  router.get("/status", requireAuth, (req, res) => {
    res.json({ ...googleOAuthStatus(), connection: connectionHealth(req.session.userId, service) });
  });

  router.get("/connect", requireAuth, (req, res) => {
    try {
      const state = cryptoRandom();
      req.session[stateKey] = state;
      res.redirect(buildAuthorizationUrl(service, state));
    } catch (err) {
      res.status(503).json({ error: `${label} integration is not configured`, detail: err.detail || err.message });
    }
  });

  router.get("/callback", requireAuth, async (req, res) => {
    const { code, state, error, error_description } = req.query;
    if (error) return res.redirect(`/app/integrations?${service}_error=${encodeURIComponent(error_description || error)}`);
    if (!state || state !== req.session[stateKey]) return res.redirect(`/app/integrations?${service}_error=Invalid%20OAuth%20state`);
    delete req.session[stateKey];

    try {
      const { accessToken, refreshToken, expiresAt, scopes } = await exchangeCodeForToken(service, code);
      saveConnection(req.session.userId, service, { accessToken, refreshToken, expiresAt, scopes, meta: {} });
      logActivity(db, req.session.userId, "integration_connected", `Connected ${label}`);
      res.redirect(`/app/integrations?${service}_connected=1`);
    } catch (err) {
      res.redirect(`/app/integrations?${service}_error=${encodeURIComponent(err.message)}`);
    }
  });

  router.post("/disconnect", requireAuth, (req, res) => {
    disconnectIntegration(req.session.userId, service);
    logActivity(db, req.session.userId, "integration_disconnected", `Disconnected ${label}`);
    res.json({ ok: true });
  });

  return router;
}
