import { Router } from "express";
import db from "../db.js";
import { requireAuth } from "../middleware.js";
import { metaOAuthStatus } from "../integrations/meta/oauth.js";
import { googleOAuthStatus } from "../integrations/gmail/oauth.js";
import { googleOAuthStatus as googleServiceOAuthStatus } from "../integrations/google/oauth.js";
import { connectionHealth } from "../integrations/manager.js";

const router = Router();
router.use(requireAuth);

// Catalog of integrations the platform will support. status here is the real,
// per-user connection status — nothing is faked as connected.
const CATALOG = [
  { provider: "meta_ads", name: "Meta Ads", note: "Priority integration", available: true, connectType: "redirect", connectPath: "/api/integrations/meta/connect" },
  { provider: "whatsapp", name: "WhatsApp Business", available: true, connectType: "manual" },
  { provider: "wordpress", name: "WordPress", available: true, connectType: "manual" },
  { provider: "woocommerce", name: "WooCommerce", available: true, connectType: "manual" },
  { provider: "gmail", name: "Gmail", available: true, connectType: "redirect", connectPath: "/api/integrations/gmail/connect" },
  { provider: "google_calendar", name: "Google Calendar", available: true, connectType: "redirect", connectPath: "/api/integrations/google_calendar/connect" },
  { provider: "google_drive", name: "Google Drive", available: true, connectType: "redirect", connectPath: "/api/integrations/google_drive/connect" },
  { provider: "google_docs", name: "Google Docs", available: true, connectType: "redirect", connectPath: "/api/integrations/google_docs/connect" },
  { provider: "google_sheets", name: "Google Sheets", available: true, connectType: "redirect", connectPath: "/api/integrations/google_sheets/connect" },
  { provider: "shopify", name: "Shopify", available: true, connectType: "manual" },
  { provider: "slack", name: "Slack", available: false },
  { provider: "telegram", name: "Telegram", available: false },
];

router.get("/", (req, res) => {
  const health = Object.fromEntries(CATALOG.map((c) => [c.provider, connectionHealth(req.session.userId, c.provider)]));
  const metaStatus = metaOAuthStatus();
  const gmailStatus = googleOAuthStatus();
  const whatsappWebhookConfigured = Boolean(process.env.WHATSAPP_VERIFY_TOKEN && process.env.META_APP_SECRET);
  res.json(
    CATALOG.map((c) => ({
      ...c,
      status: health[c.provider]?.connected ? "connected" : "not_connected",
      sharedFromOrg: Boolean(health[c.provider]?.sharedFromOrg),
      // Meta Ads/Gmail are "available" as features, but still need the app
      // owner (you) to have set the right env vars — surface that
      // distinction so the UI can explain rather than just fail on click.
      setupRequired:
        c.provider === "meta_ads" && !metaStatus.configured ? metaStatus.reason
        : c.provider === "gmail" && !gmailStatus.configured ? gmailStatus.reason
        : ["google_calendar", "google_drive", "google_docs", "google_sheets"].includes(c.provider) && !googleServiceOAuthStatus().configured
        ? googleServiceOAuthStatus().reason
        : c.provider === "whatsapp" && !whatsappWebhookConfigured ? "WHATSAPP_VERIFY_TOKEN and META_APP_SECRET must be set for incoming messages to work"
        : null,
    }))
  );
});

export default router;
