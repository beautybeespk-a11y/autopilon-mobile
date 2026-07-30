import { Router } from "express";
import { requireAuth, cryptoRandom, logActivity } from "../middleware.js";
import db from "../db.js";
import { buildAuthorizationUrl, exchangeCodeForToken, googleOAuthStatus } from "../integrations/gmail/oauth.js";
import { saveConnection, disconnectIntegration, connectionHealth } from "../integrations/manager.js";

const router = Router();

router.get("/status", requireAuth, (req, res) => {
  res.json({ ...googleOAuthStatus(), connection: connectionHealth(req.session.userId, "gmail") });
});

router.get("/connect", requireAuth, (req, res) => {
  try {
    const state = cryptoRandom();
    req.session.googleOAuthState = state;
    res.redirect(buildAuthorizationUrl(state));
  } catch (err) {
    res.status(503).json({ error: "Gmail integration is not configured", detail: err.detail || err.message });
  }
});

router.get("/callback", requireAuth, async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.redirect(`/app/integrations?gmail_error=${encodeURIComponent(error_description || error)}`);
  if (!state || state !== req.session.googleOAuthState) return res.redirect("/app/integrations?gmail_error=Invalid%20OAuth%20state");
  delete req.session.googleOAuthState;

  try {
    const { accessToken, refreshToken, expiresAt, scopes } = await exchangeCodeForToken(code);
    saveConnection(req.session.userId, "gmail", { accessToken, refreshToken, expiresAt, scopes, meta: {} });
    logActivity(db, req.session.userId, "integration_connected", "Connected Gmail");
    res.redirect("/app/integrations?gmail_connected=1");
  } catch (err) {
    res.redirect(`/app/integrations?gmail_error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/disconnect", requireAuth, (req, res) => {
  disconnectIntegration(req.session.userId, "gmail");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected Gmail");
  res.json({ ok: true });
});

export default router;
