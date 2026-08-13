import db from "../../../db.js";
import { cryptoRandom } from "../../../middleware.js";
import { isDuplicateEvent } from "../../../orchestrator/webhookDedup.js";

export { isDuplicateEvent };

// Gets or creates the linked web conversation for a (userId, contactPhone)
// pair. This is the mechanism that keeps "one unified conversation history"
// true — WhatsApp messages and web chat messages for the same contact land
// in the exact same `conversations`/`messages` rows, not a parallel copy.
export function resolveConversation(userId, contactPhone, agentId) {
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT * FROM whatsapp_conversations WHERE userId = ? AND contactPhone = ?"
  ).get(userId, contactPhone);

  if (existing) {
    db.prepare("UPDATE whatsapp_conversations SET lastMessageAt = ? WHERE id = ?").run(now, existing.id);
    return existing.conversationId;
  }

  const conversationId = cryptoRandom();
  db.prepare(
    "INSERT INTO conversations (id, userId, agentId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(conversationId, userId, agentId || null, `WhatsApp: ${contactPhone}`, now, now);

  db.prepare(
    "INSERT INTO whatsapp_conversations (id, userId, contactPhone, conversationId, createdAt, lastMessageAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(cryptoRandom(), userId, contactPhone, conversationId, now, now);

  return conversationId;
}

export function getContactPhoneForConversation(conversationId) {
  const row = db.prepare("SELECT contactPhone FROM whatsapp_conversations WHERE conversationId = ?").get(conversationId);
  return row?.contactPhone || null;
}

export function logWhatsAppMessage({ messageId, waMessageId, direction, type, status }) {
  db.prepare(
    "INSERT INTO whatsapp_messages (id, messageId, waMessageId, direction, type, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(cryptoRandom(), messageId || null, waMessageId || null, direction, type || "text", status || null, new Date().toISOString());
}

export function updateMessageStatus(waMessageId, status) {
  db.prepare("UPDATE whatsapp_messages SET status = ? WHERE waMessageId = ?").run(status, waMessageId);
}
