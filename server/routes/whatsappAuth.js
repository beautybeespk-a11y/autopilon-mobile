import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { saveConnection, disconnectIntegration, getConnection, connectionHealth } from "../integrations/manager.js";
import { checkConnectionHealth } from "../integrations/whatsapp/api.js";

const router = Router();
router.use(requireAuth);

const DEFAULT_SETTINGS = {
  autoReply: true,
  businessHours: null, // e.g. { start: "09:00", end: "18:00", timezone: "Asia/Karachi" } — null means always on
  defaultAgentId: null,
  greetingMessage: "Hi! How can I help you today?",
  awayMessage: "Thanks for reaching out — we're outside business hours right now and will get back to you soon.",
  language: "en",
  notifications: true,
};

router.get("/status", (req, res) => {
  const conn = getConnection(req.session.userId, "whatsapp");
  const health = connectionHealth(req.session.userId, "whatsapp");
  const meta = conn?.meta ? JSON.parse(conn.meta) : null;
  res.json({
    ...health,
    businessName: meta?.businessName || null,
    phoneNumber: meta?.phoneNumber || null,
    wabaId: meta?.wabaId || null,
    connectedSince: conn?.createdAt || null,
    webhookConfigured: Boolean(process.env.WHATSAPP_VERIFY_TOKEN && process.env.META_APP_SECRET),
  });
});

// Manual connect: the user pastes credentials generated in Meta's dashboard
// (System User token + phone_number_id + WABA id). This is verified against
// the real API before being saved — never trust an unchecked token.
router.post("/connect", async (req, res) => {
  const { accessToken, phoneNumberId, wabaId, businessName } = req.body || {};
  if (!accessToken || !phoneNumberId) {
    return res.status(400).json({ error: "accessToken and phoneNumberId are required." });
  }
  try {
    const info = await checkConnectionHealth(phoneNumberId, accessToken);
    saveConnection(req.session.userId, "whatsapp", {
      accessToken,
      expiresAt: null, // System User tokens are typically long-lived/non-expiring, unlike Meta Ads' user tokens
      scopes: ["whatsapp_business_messaging"],
      meta: {
        phoneNumberId,
        wabaId: wabaId || null,
        businessName: businessName || info.verified_name || null,
        phoneNumber: info.display_phone_number || null,
        settings: DEFAULT_SETTINGS,
      },
    });
    logActivity(db, req.session.userId, "integration_connected", "Connected WhatsApp Business");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "Could not verify this WhatsApp connection.", detail: err.message });
  }
});

// Phase 18.2 §3: classified REQUIRES EXTERNAL CONFIGURATION, not
// SUPPORTED — this token is a Meta System User access token, generated
// and managed in Meta Business Manager, not a per-user OAuth grant this
// app created. Meta's /me/permissions de-authorize endpoint (used for
// metaAuth.js's per-user Ads token) has undocumented semantics against a
// System User token and could plausibly affect other apps/integrations
// sharing that same System User in Business Manager — not a call this
// app can safely make on the user's behalf without real risk of
// unintended side effects outside this integration. The user revokes or
// regenerates the token themselves in Meta Business Manager. `revoked:
// null` is the honest answer; local credentials are always still fully
// deleted below.
router.post("/disconnect", (req, res) => {
  disconnectIntegration(req.session.userId, "whatsapp");
  logActivity(db, req.session.userId, "integration_disconnected", "Disconnected WhatsApp Business");
  res.json({ ok: true, revoked: null, revocationError: null });
});

router.get("/settings", (req, res) => {
  const conn = getConnection(req.session.userId, "whatsapp");
  if (!conn) return res.status(404).json({ error: "WhatsApp is not connected." });
  const meta = JSON.parse(conn.meta || "{}");
  res.json({ ...DEFAULT_SETTINGS, ...(meta.settings || {}) });
});

router.patch("/settings", (req, res) => {
  const conn = getConnection(req.session.userId, "whatsapp");
  if (!conn) return res.status(404).json({ error: "WhatsApp is not connected." });
  const meta = JSON.parse(conn.meta || "{}");
  meta.settings = { ...DEFAULT_SETTINGS, ...(meta.settings || {}), ...req.body };
  db.prepare("UPDATE integrations SET meta = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(meta), new Date().toISOString(), conn.id);
  res.json(meta.settings);
});

export default router;
