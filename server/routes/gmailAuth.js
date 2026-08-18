import { Router } from "express";
import { requireAuth, secureRandomToken, logActivity } from "../middleware.js";
import db from "../db.js";
import { buildAuthorizationUrl, exchangeCodeForToken, googleOAuthStatus, revokeToken } from "../integrations/gmail/oauth.js";
import { saveConnection, disconnectIntegration, connectionHealth, getConnection } from "../integrations/manager.js";

const router = Router();

router.get("/status", requireAuth, (req, res) => {
  res.json({ ...googleOAuthStatus(), connection: connectionHealth(req.session.userId, "gmail") });
});

router.get("/connect", requireAuth, (req, res) => {
  try {
    const state = secureRandomToken();
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
    // Phase 18.2 §11: err.message here is Google's own token-exchange
    // error text (see gmail/oauth.js's exchangeCodeForToken) — never the
    // authorization code or any credential value, safe to log as-is.
    logActivity(db, req.session.userId, "integration_connection_failed", `Gmail connection failed: ${err.message}`, { req, result: "failure" });
    res.redirect(`/app/integrations?gmail_error=${encodeURIComponent(err.message)}`);
  }
});

// Phase 18.2 §2: revoke the real Google grant before wiping the local
// record, not instead of it — decrypted only right here inside the
// server-side credential layer (getConnection() does the decryption; this
// route never sees ciphertext or forwards the value anywhere). A failed
// provider-side revocation is never treated as a reason to leave local
// credentials usable: disconnectIntegration() always runs regardless of
// what happened above it, and the response is honest about which part
// (local vs. provider) actually succeeded.
router.post("/disconnect", requireAuth, async (req, res) => {
  const conn = getConnection(req.session.userId, "gmail");
  const tokenToRevoke = conn?.refreshToken || conn?.accessToken || null;
  let revocationError = null;
  if (tokenToRevoke) {
    try {
      await revokeToken(tokenToRevoke);
    } catch (err) {
      revocationError = err.message;
      logActivity(db, req.session.userId, "integration_revocation_failed", `Gmail token revocation with Google failed: ${err.message}`, { req, result: "failure" });
    }
  }
  disconnectIntegration(req.session.userId, "gmail");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected Gmail");
  res.json({ ok: true, revoked: tokenToRevoke ? !revocationError : null, revocationError });
});

export default router;
