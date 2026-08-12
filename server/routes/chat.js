import { Router } from "express";
import db from "../db.js";
import { requireAuth, cryptoRandom, logActivity } from "../middleware.js";
import { providerStatus, listProviderOptions } from "../ai/provider.js";
import { handleIncomingMessage } from "../orchestrator/conversationService.js";

const router = Router();
router.use(requireAuth);

router.get("/provider-status", (req, res) => res.json(providerStatus()));
router.get("/provider-options", (req, res) => res.json(listProviderOptions()));

// List conversations for the signed-in user
router.get("/conversations", (req, res) => {
  const rows = db.prepare(
    "SELECT id, title, agentId, createdAt, updatedAt FROM conversations WHERE userId = ? ORDER BY updatedAt DESC"
  ).all(req.session.userId);
  res.json(rows);
});

router.get("/conversations/:id/messages", (req, res) => {
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ? AND userId = ?").get(req.params.id, req.session.userId);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const msgs = db.prepare("SELECT id, role, content, createdAt, meta FROM messages WHERE conversationId = ? ORDER BY createdAt ASC").all(conv.id);
  const parsed = msgs.map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
  res.json({ conversation: conv, messages: parsed });
});

// Send a message. Creates a conversation if none supplied.
router.post("/message", async (req, res) => {
  const { conversationId, content, agentId, attachmentTitle, attachmentText, attachmentImageId, attachmentFileId } = req.body || {};
  const hasAttachment = Boolean(attachmentTitle && (attachmentText || attachmentImageId || attachmentFileId));
  // Temporary diagnostic — remove once image attachments are confirmed
  // working end-to-end. Shows exactly what the client sent for this field,
  // without dumping the (large) attachmentText/body itself.
  console.log("[chat/message] attachment fields:", {
    attachmentTitle: attachmentTitle || null,
    hasAttachmentText: Boolean(attachmentText),
    attachmentImageId: attachmentImageId || null,
    hasAttachment,
  });
  if (!content?.trim() && !hasAttachment) return res.status(400).json({ error: "Message content is required." });
  const now = new Date().toISOString();
  const userId = req.session.userId;

  let convId = conversationId;
  if (!convId) {
    convId = cryptoRandom();
    const title = (content?.trim() || attachmentTitle || "New conversation").slice(0, 48);
    db.prepare("INSERT INTO conversations (id, userId, agentId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(convId, userId, agentId || null, title, now, now);
    logActivity(db, userId, "conversation_started", `Started "${title}"`);
  } else {
    const owns = db.prepare("SELECT id FROM conversations WHERE id = ? AND userId = ?").get(convId, userId);
    if (!owns) return res.status(404).json({ error: "Conversation not found" });
  }

  try {
    const { reply, trace, toolResults, confirmation, assistantMessageId } = await handleIncomingMessage({
      userId, agentId: agentId || null, conversationId: convId, content: content || "",
      attachmentTitle: hasAttachment ? attachmentTitle : null,
      attachmentText: hasAttachment ? attachmentText : null,
      attachmentImageId: hasAttachment ? attachmentImageId : null,
      attachmentFileId: hasAttachment ? attachmentFileId : null,
    });
    res.json({ conversationId: convId, reply, trace, toolResults, confirmation, assistantMessageId });
  } catch (err) {
    // Logged so the real cause is visible in the server terminal — the
    // client only ever sees a generic "AI provider returned an error."
    console.error("[chat/message] error:", err);
    if (err.code === "PROVIDER_NOT_CONFIGURED") {
      return res.status(503).json({ error: "AI provider not configured", detail: err.detail, conversationId: convId });
    }
    res.status(502).json({ error: "The AI provider returned an error.", detail: err.message, conversationId: convId });
  }
});

// Called by the chat UI right after a confirmation card is resolved
// (approved/rejected) — without this, the message's stored meta.confirmation
// stays frozen at "pending" forever, so a page refresh keeps showing the
// same card even though the underlying action already ran.
router.patch("/messages/:id/confirmation", (req, res) => {
  const { resolution } = req.body || {}; // "approved" | "rejected" | "error"
  const message = db.prepare(
    `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversationId
     WHERE m.id = ? AND c.userId = ?`
  ).get(req.params.id, req.session.userId);
  if (!message) return res.status(404).json({ error: "Message not found" });

  const meta = JSON.parse(message.meta || "{}");
  meta.confirmation = meta.confirmation ? { ...meta.confirmation, resolution } : null;
  db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), message.id);
  res.json({ ok: true });
});

export default router;
