import { Router } from "express";
import { requireAuth, secureRandomToken, logActivity } from "../middleware.js";
import db from "../db.js";
import { buildAuthorizationUrl, exchangeCodeForToken, metaOAuthStatus, revokeToken } from "../integrations/meta/oauth.js";
import { saveConnection, disconnectIntegration, connectionHealth, getConnection, requireValidToken, updateConnectionMeta } from "../integrations/manager.js";
import * as meta from "../integrations/meta/api.js";
import { isPlausibleAdAccountId } from "../tools/shared/metaAdAccountId.js";

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
    logActivity(db, req.session.userId, "integration_connection_failed", `Meta Ads connection failed: ${err.message}`, { req, result: "failure" });
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

// Integrations → Meta Ads' ad account selector: the real connected
// accounts (name + id, requirement 8) plus whichever one (if any) is
// currently saved as the Default Ad Account — read straight from the same
// `integrations.meta` JSON blob resolveAdAccountId() itself reads
// (server/tools/shared/metaAdAccountId.js), so the UI and the resolver can
// never disagree about what "the default" currently is.
router.get("/ad-accounts", requireAuth, async (req, res) => {
  try {
    const accessToken = requireValidToken(req.session.userId, "meta_ads");
    const accounts = await meta.listAdAccounts(accessToken);
    const conn = getConnection(req.session.userId, "meta_ads");
    const savedDefault = JSON.parse(conn?.meta || "{}").defaults?.adAccountId || null;
    // Same self-healing the resolver does: don't show a default in the UI
    // that no longer corresponds to a real connected account.
    const defaultAdAccountId = savedDefault && accounts.some((a) => a.id === savedDefault) ? savedDefault : null;
    res.json({ accounts, defaultAdAccountId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Sets (or clears, with adAccountId: null) the Default Ad Account. Always
// re-verifies the id against a fresh meta.listAdAccounts() call before
// saving — never trusts a client-supplied id just because it's shaped
// like one, same principle resolveAdAccountId() applies to a tool call.
router.post("/default-ad-account", requireAuth, async (req, res) => {
  const { adAccountId } = req.body || {};
  // updateConnectionMeta() merges shallowly at the top level — writing
  // `defaults` wholesale would silently drop any other key already inside
  // it (e.g. a future defaultPageId), so the existing `defaults` object is
  // read and spread first rather than replaced outright.
  const setDefault = (value) => {
    const conn = getConnection(req.session.userId, "meta_ads");
    const currentDefaults = JSON.parse(conn?.meta || "{}").defaults || {};
    return updateConnectionMeta(req.session.userId, "meta_ads", { defaults: { ...currentDefaults, adAccountId: value } });
  };
  try {
    if (adAccountId === null || adAccountId === undefined) {
      const updated = setDefault(null);
      if (!updated) return res.status(400).json({ error: "Meta Ads is not connected." });
      return res.json({ defaultAdAccountId: null });
    }
    if (!isPlausibleAdAccountId(adAccountId)) {
      return res.status(400).json({ error: `"${adAccountId}" is not a valid Meta ad account id.` });
    }
    const accessToken = requireValidToken(req.session.userId, "meta_ads");
    const accounts = await meta.listAdAccounts(accessToken);
    const match = accounts.find((a) => a.id === adAccountId);
    if (!match) {
      return res.status(404).json({ error: `"${adAccountId}" is not one of this account's connected Meta ad accounts.`, accounts });
    }
    setDefault(match.id);
    logActivity(db, req.session.userId, "integration_updated", `Set Default Ad Account for Meta Ads: ${match.name} (${match.id})`);
    res.json({ defaultAdAccountId: match.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
