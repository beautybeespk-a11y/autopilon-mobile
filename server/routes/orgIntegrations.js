import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { hasPermission, getMembership } from "../orchestrator/rbac.js";
import { listOrgConnections, saveOrgConnection, disconnectOrgConnection } from "../integrations/manager.js";
import { checkSite as checkWordPressSite } from "../integrations/wordpress/api.js";
import { checkStore as checkWooCommerceStore } from "../integrations/woocommerce/api.js";
import { checkStore as checkShopifyStore } from "../integrations/shopify/api.js";
import { enforceQuota } from "../orchestrator/billing.js";

const router = Router();
router.use(requireAuth);

// Only manual-token providers are supported for org-level connections in
// this slice — OAuth providers (Gmail, Meta Ads, Calendar/Drive/Docs/Sheets)
// would each need their own org-aware callback route, which is a larger,
// separate follow-up. Disclosed scope cut, not silently missing.
//
// `secretField` names exactly which submitted field is the real long-lived
// credential — it goes into the encrypted accessToken column (via
// saveOrgConnection(), Phase 18.1 §1) and is stripped out of `meta`
// (everything else in the submission is not a secret by itself: a site
// URL, a username, a consumer *key* as opposed to secret, a shop domain).
// This mirrors the equivalent personal-connection routes (routes/
// wordpressAuth.js, woocommerceAuth.js, shopifyAuth.js), which already did
// this correctly — this generic org-level handler previously did not:
// it picked `consumerKey` (not the real secret) for WooCommerce, and
// copied the raw secret into `meta` in plaintext for every provider here.
const MANUAL_PROVIDERS = {
  wordpress: { label: "WordPress", verify: (f) => checkWordPressSite(f.siteUrl, f.username, f.appPassword), fields: ["siteUrl", "username", "appPassword"], secretField: "appPassword" },
  woocommerce: { label: "WooCommerce", verify: (f) => checkWooCommerceStore(f.siteUrl, f.consumerKey, f.consumerSecret), fields: ["siteUrl", "consumerKey", "consumerSecret"], secretField: "consumerSecret" },
  shopify: { label: "Shopify", verify: (f) => checkShopifyStore(f.shopDomain, f.accessToken), fields: ["shopDomain", "accessToken"], secretField: "accessToken" },
};

router.get("/:orgId/integrations", (req, res) => {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership) return res.status(403).json({ error: "You're not a member of this organization." });
  const connections = listOrgConnections(req.params.orgId);
  const byProvider = Object.fromEntries(connections.map((c) => [c.provider, c]));
  const catalog = Object.keys(MANUAL_PROVIDERS).map((id) => ({
    provider: id,
    label: MANUAL_PROVIDERS[id].label,
    connected: byProvider[id]?.status === "connected",
    connectedAt: byProvider[id]?.updatedAt || null,
  }));
  res.json(catalog);
});

router.post("/:orgId/integrations/:provider/connect", async (req, res) => {
  const { orgId, provider } = req.params;
  if (!hasPermission(orgId, req.session.userId, "integrations")) {
    return res.status(403).json({ error: "You don't have permission to manage this organization's integrations." });
  }
  const config = MANUAL_PROVIDERS[provider];
  if (!config) return res.status(400).json({ error: `Organization-level connection isn't available yet for "${provider}" — it's an OAuth-based integration in this version.` });

  const missing = config.fields.filter((f) => !req.body?.[f]);
  if (missing.length) return res.status(400).json({ error: `Missing required field(s): ${missing.join(", ")}` });

  try {
    enforceQuota(orgId, "maxIntegrations", "connected integrations");
    await config.verify(req.body);
    const { [config.secretField]: accessToken, ...meta } = req.body; // real secret goes to the encrypted column, never into meta
    saveOrgConnection(orgId, req.session.userId, provider, { accessToken, meta });
    logActivity(db, req.session.userId, "org_integration_connected", `Connected ${config.label} for the organization`, { orgId, req });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "Could not verify this connection.", detail: err.message });
  }
});

// Phase 18.2 §3: every provider here (wordpress/woocommerce/shopify) is
// manual-token/API-key — none has a revoke call this app can make; see
// the equivalent personal-connection routes for why, per provider.
// `revoked: null` is the honest answer; local credentials are always
// still fully deleted below.
router.post("/:orgId/integrations/:provider/disconnect", (req, res) => {
  const { orgId, provider } = req.params;
  if (!hasPermission(orgId, req.session.userId, "integrations")) {
    return res.status(403).json({ error: "You don't have permission to manage this organization's integrations." });
  }
  disconnectOrgConnection(orgId, provider);
  logActivity(db, req.session.userId, "org_integration_disconnected", `Disconnected an organization integration`, { orgId, req });
  res.json({ ok: true, revoked: null, revocationError: null });
});

export default router;
