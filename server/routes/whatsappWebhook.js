import { Router } from "express";
import db from "../db.js";
import { verifyWebhookSignature } from "../integrations/whatsapp/validation.js";
import { parseWebhookPayload } from "../integrations/whatsapp/webhook.js";
import { findOwnerByPhoneNumberId } from "../integrations/whatsapp/services/ownerLookup.js";
import { resolveConversation, logWhatsAppMessage, updateMessageStatus, isDuplicateEvent } from "../integrations/whatsapp/services/conversationResolver.js";
import { handleIncomingMessage } from "../orchestrator/conversationService.js";
import { sendTextMessage } from "../integrations/whatsapp/api.js";
import { publishEvent } from "../automation/triggers.js";

const router = Router();

// This route is intentionally NOT behind requireAuth — Meta calls it
// directly, with no user session. Every request is instead validated by
// its HMAC signature against META_APP_SECRET.

// Meta's one-time webhook verification handshake.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post("/webhook", (req, res) => {
  const signature = req.get("x-hub-signature-256");
  const appSecret = process.env.META_APP_SECRET; // WhatsApp webhooks are signed with the same app secret as the Meta App
  if (!verifyWebhookSignature(req.rawBody, signature, appSecret)) {
    return res.sendStatus(401);
  }

  // Ack immediately — Meta expects a fast 200 and will retry aggressively
  // (and duplicate-deliver) if the response is slow. Actual processing
  // (which may call the AI and take real time) happens after responding.
  res.sendStatus(200);
  processWebhookEvents(req.body).catch((err) => {
    console.error("WhatsApp webhook processing error:", err.message);
  });
});

async function processWebhookEvents(body) {
  const events = parseWebhookPayload(body);

  for (const event of events) {
    if (event.kind === "status") {
      if (isDuplicateEvent(`status:${event.waMessageId}:${event.status}`, "status")) continue;
      updateMessageStatus(event.waMessageId, event.status);
      continue;
    }

    if (event.kind === "error") {
      console.error("WhatsApp reported an error event:", event.message);
      continue;
    }

    if (event.kind !== "message") continue;
    if (isDuplicateEvent(event.waMessageId, "message")) continue; // Meta redelivered this one

    const owner = findOwnerByPhoneNumberId(event.phoneNumberId);
    if (!owner) continue; // not a connected number in this app — ignore safely

    if (event.type === "unsupported") {
      logWhatsAppMessage({ waMessageId: event.waMessageId, direction: "inbound", type: event.rawType, status: "received" });
      continue; // per spec: unsupported types must never crash the system
    }

    const content =
      event.type === "text" ? event.text
      : event.type === "location" ? `[Location shared: ${event.location?.latitude}, ${event.location?.longitude}]`
      : `[${event.type} message received]`;

    const settings = JSON.parse(db.prepare("SELECT meta FROM integrations WHERE userId = ? AND provider = 'whatsapp'").get(owner.userId)?.meta || "{}");
    const agentId = settings.defaultAgentId || db.prepare("SELECT id FROM agents WHERE userId = ? ORDER BY createdAt ASC LIMIT 1").get(owner.userId)?.id || null;

    const conversationId = resolveConversation(owner.userId, event.from, agentId);
    logWhatsAppMessage({ waMessageId: event.waMessageId, direction: "inbound", type: event.type, status: "received" });

    // Publish the event-driven trigger BEFORE the AI reply — a workflow
    // reacting to "keyword contains price" shouldn't depend on whether the
    // agent's own reply succeeds. This is additive: the existing tested
    // reply flow below is completely unchanged.
    publishEvent(owner.userId, "whatsapp", "whatsapp_message", {
      senderPhone: event.from,
      messageText: content,
      messageType: event.type,
      conversationId,
    }, event.waMessageId);

    try {
      const { reply, assistantMessageId } = await handleIncomingMessage({
        userId: owner.userId, agentId, conversationId, content,
      });
      const sent = await sendTextMessage(owner.meta.phoneNumberId, owner.accessToken, event.from, reply);
      logWhatsAppMessage({ messageId: assistantMessageId, waMessageId: sent.messages?.[0]?.id, direction: "outbound", type: "text", status: "sent" });
    } catch (err) {
      // Never leave the user without a reply just because something failed internally.
      try {
        await sendTextMessage(owner.meta.phoneNumberId, owner.accessToken, event.from, "Sorry, I ran into a problem processing that. Please try again in a moment.");
      } catch { /* best-effort — don't let a send failure mask the original error */ }
      console.error("WhatsApp message handling failed:", err.message);
    }
  }
}

export default router;
