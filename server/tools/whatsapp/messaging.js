import db from "../../db.js";
import { registerTool } from "../registry.js";
import { getConnection, requireValidToken } from "../../integrations/manager.js";
import { resolveConversation, logWhatsAppMessage } from "../../integrations/whatsapp/services/conversationResolver.js";
import * as wa from "../../integrations/whatsapp/api.js";

// Every WhatsApp tool needs the phone_number_id alongside the access token —
// pull both from the stored connection once, here.
function waContext(userId) {
  const accessToken = requireValidToken(userId, "whatsapp"); // throws a clean error if not connected
  const conn = getConnection(userId, "whatsapp");
  const meta = JSON.parse(conn.meta || "{}");
  if (!meta.phoneNumberId) {
    const err = new Error("WhatsApp is connected but missing a phone number ID. Reconnect it in Integrations.");
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  return { accessToken, phoneNumberId: meta.phoneNumberId };
}

registerTool({
  name: "send_whatsapp_message",
  description: "Sends a new WhatsApp text message to a phone number. Logs it into the same conversation history shown on the web.",
  category: "whatsapp",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, message: { type: "string" } },
    required: ["to", "message"],
  },
  requiredPermissions: ["whatsapp.write"],
  requiresConfirmation: true, // Contacts a real person outside the app — always confirm first.
  async execute(parameters, context) {
    const { accessToken, phoneNumberId } = waContext(context.userId);
    const result = await wa.sendTextMessage(phoneNumberId, accessToken, parameters.to, parameters.message);
    const conversationId = resolveConversation(context.userId, parameters.to, context.agentId || null);
    logWhatsAppMessage({ waMessageId: result.messages?.[0]?.id, direction: "outbound", type: "text", status: "sent" });
    return { to: parameters.to, status: "sent", conversationId };
  },
});

registerTool({
  name: "reply_whatsapp_message",
  description: "Replies within an existing WhatsApp conversation, identified by the contact's phone number.",
  category: "whatsapp",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, message: { type: "string" } },
    required: ["to", "message"],
  },
  requiredPermissions: ["whatsapp.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { accessToken, phoneNumberId } = waContext(context.userId);
    const result = await wa.sendTextMessage(phoneNumberId, accessToken, parameters.to, parameters.message);
    logWhatsAppMessage({ waMessageId: result.messages?.[0]?.id, direction: "outbound", type: "text", status: "sent" });
    return { to: parameters.to, status: "sent" };
  },
});

registerTool({
  name: "list_whatsapp_conversations",
  description: "Lists the authenticated user's WhatsApp conversations (contact phone numbers and last activity).",
  category: "whatsapp",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["whatsapp.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const rows = db.prepare(
      "SELECT contactPhone, conversationId, lastMessageAt FROM whatsapp_conversations WHERE userId = ? ORDER BY lastMessageAt DESC"
    ).all(context.userId);
    return { conversations: rows };
  },
});

registerTool({
  name: "get_whatsapp_conversation",
  description: "Returns recent messages from a specific WhatsApp conversation, identified by the contact's phone number.",
  category: "whatsapp",
  parameters: {
    type: "object",
    properties: { contactPhone: { type: "string" } },
    required: ["contactPhone"],
  },
  requiredPermissions: ["whatsapp.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const conv = db.prepare(
      "SELECT conversationId FROM whatsapp_conversations WHERE userId = ? AND contactPhone = ?"
    ).get(context.userId, parameters.contactPhone);
    if (!conv) return { messages: [], found: false };
    const messages = db.prepare(
      "SELECT role, content, createdAt FROM messages WHERE conversationId = ? ORDER BY createdAt DESC LIMIT 20"
    ).all(conv.conversationId);
    return { messages: messages.reverse(), found: true };
  },
});

registerTool({
  name: "mark_message_read",
  description: "Marks a WhatsApp message as read.",
  category: "whatsapp",
  parameters: {
    type: "object",
    properties: { waMessageId: { type: "string" } },
    required: ["waMessageId"],
  },
  requiredPermissions: ["whatsapp.write"],
  requiresConfirmation: false, // Read receipts aren't sensitive — no real-world consequence to confirm.
  async execute(parameters, context) {
    const { accessToken, phoneNumberId } = waContext(context.userId);
    await wa.markMessageRead(phoneNumberId, accessToken, parameters.waMessageId);
    return { waMessageId: parameters.waMessageId, marked: true };
  },
});

registerTool({
  name: "send_image",
  description: "Sends an image to a WhatsApp contact via a public image URL.",
  category: "whatsapp",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, imageUrl: { type: "string" }, caption: { type: "string" } },
    required: ["to", "imageUrl"],
  },
  requiredPermissions: ["whatsapp.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { accessToken, phoneNumberId } = waContext(context.userId);
    const result = await wa.sendImageMessage(phoneNumberId, accessToken, parameters.to, { link: parameters.imageUrl, caption: parameters.caption });
    logWhatsAppMessage({ waMessageId: result.messages?.[0]?.id, direction: "outbound", type: "image", status: "sent" });
    return { to: parameters.to, status: "sent" };
  },
});

registerTool({
  name: "send_document",
  description: "Sends a document to a WhatsApp contact via a public file URL.",
  category: "whatsapp",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, fileUrl: { type: "string" }, filename: { type: "string" }, caption: { type: "string" } },
    required: ["to", "fileUrl"],
  },
  requiredPermissions: ["whatsapp.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { accessToken, phoneNumberId } = waContext(context.userId);
    const result = await wa.sendDocumentMessage(phoneNumberId, accessToken, parameters.to, { link: parameters.fileUrl, filename: parameters.filename, caption: parameters.caption });
    logWhatsAppMessage({ waMessageId: result.messages?.[0]?.id, direction: "outbound", type: "document", status: "sent" });
    return { to: parameters.to, status: "sent" };
  },
});

registerTool({
  name: "send_template_message",
  description: "Sends a pre-approved WhatsApp message template — required to start a conversation outside the 24-hour customer service window.",
  category: "whatsapp",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, templateName: { type: "string" }, languageCode: { type: "string" } },
    required: ["to", "templateName"],
  },
  requiredPermissions: ["whatsapp.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { accessToken, phoneNumberId } = waContext(context.userId);
    const result = await wa.sendTemplateMessage(phoneNumberId, accessToken, parameters.to, {
      templateName: parameters.templateName,
      languageCode: parameters.languageCode || "en_US",
    });
    logWhatsAppMessage({ waMessageId: result.messages?.[0]?.id, direction: "outbound", type: "template", status: "sent" });
    return { to: parameters.to, status: "sent" };
  },
});
