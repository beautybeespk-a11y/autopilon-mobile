import { Router } from "express";
import { requireAuth, secureRandomToken, logActivity } from "../middleware.js";
import db from "../db.js";
import { buildAuthorizationUrl, exchangeCodeForToken, metaOAuthStatus, revokeToken } from "../integrations/meta/oauth.js";
import { saveConnection, disconnectIntegration, connectionHealth, getConnection } from "../integrations/manager.js";

const router = Router();

router.get("/status", requireAuth, (req, res) => {
  res.json({ ...metaOAuthStatus(), connection: connectionHealth(req.session.userId, "meta_ads") });
});

// Starts the OAuth flow. A random `state` is stashed in the session and
// checked on callback — standard CSRF protection for the redirect flow.
router.get("/connect", requireAuth, (req, res) => {
  try {
    const state = secureRandomToken();
    req.session.metaOAuthState = state;
    const url = buildAuthorizationUrl(state);
    res.redirect(url);
  } catch (err) {
    res.status(503).json({ error: "Meta integration is not configured", detail: err.detail || err.message });
  }
});

router.get("/callback", requireAuth, async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.redirect(`/app/integrations?meta_error=${encodeURIComponent(error_description || error)}`);
  }
  if (!state || state !== req.session.metaOAuthState) {
    return res.redirect("/app/integrations?meta_error=Invalid%20OAuth%20state");
  }
  delete req.session.metaOAuthState;

  try {
    const { accessToken, expiresAt, scopes } = await exchangeCodeForToken(code);
    saveConnection(req.session.userId, "meta_ads", { accessToken, expiresAt, scopes });
    logActivity(db, req.session.userId, "integration_connected", "Connected Meta Ads");
    res.redirect("/app/integrations?meta_connected=1");
  } catch (err) {
    res.redirect(`/app/integrations?meta_error=${encodeURIComponent(err.message)}`);
  }
});

// Phase 18.2 §2: real de-authorization before local wipe, same reasoning
// as gmailAuth.js. Meta has no separate access/refresh token to revoke
// individually — DELETE /me/permissions revokes the whole app grant.
router.post("/disconnect", requireAuth, async (req, res) => {
  const conn = getConnection(req.session.userId, "meta_ads");
  const tokenToRevoke = conn?.accessToken || null;
  let revocationError = null;
  if (tokenToRevoke) {
    try {
      await revokeToken(tokenToRevoke);
    } catch (err) {
      revocationError = err.message;
      logActivity(db, req.session.userId, "integration_revocation_failed", `Meta Ads token revocation with Meta failed: ${err.message}`, { req, result: "failure" });
    }
  }
  disconnectIntegration(req.session.userId, "meta_ads");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected Meta Ads");
  res.json({ ok: true, revoked: tokenToRevoke ? !revocationError : null, revocationError });
});

export default router;
