import { registerTool } from "../registry.js";
import * as gmail from "../../integrations/gmail/api.js";

registerTool({
  name: "gmail.list_emails",
  description: "Lists recent emails in the inbox.",
  category: "gmail",
  parameters: { type: "object", properties: { maxResults: { type: "number" } }, required: [] },
  requiredPermissions: ["gmail.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const messages = await gmail.searchMessages(context.userId, "in:inbox", parameters.maxResults || 10);
    return { messages };
  },
});

registerTool({
  name: "gmail.search_emails",
  description: "Searches emails using Gmail's search syntax (e.g. 'from:john subject:invoice').",
  category: "gmail",
  parameters: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"] },
  requiredPermissions: ["gmail.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const messages = await gmail.searchMessages(context.userId, parameters.query, parameters.maxResults || 10);
    return { messages };
  },
});

registerTool({
  name: "gmail.read_email",
  description: "Reads the full content of a specific email.",
  category: "gmail",
  parameters: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  requiredPermissions: ["gmail.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    return gmail.getMessage(context.userId, parameters.messageId);
  },
});

registerTool({
  name: "gmail.draft_reply",
  description: "Composes a reply to an email WITHOUT sending it — returns the draft text for review. Use gmail.send_email to actually send once approved.",
  category: "gmail",
  parameters: { type: "object", properties: { messageId: { type: "string" }, body: { type: "string" } }, required: ["messageId", "body"] },
  requiredPermissions: ["gmail.read"],
  requiresConfirmation: false, // Drafting doesn't send anything — nothing to confirm yet.
  async execute(parameters, context) {
    const original = await gmail.getMessage(context.userId, parameters.messageId);
    return {
      messageId: parameters.messageId,
      to: original.from,
      subject: original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`,
      draftBody: parameters.body,
      note: "This is a draft only. Use gmail.send_email to actually send it — that step requires your approval.",
    };
  },
});

registerTool({
  name: "gmail.send_email",
  description: "Sends an email. Always requires explicit approval before sending, per the platform's email safety rules.",
  category: "gmail",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, threadId: { type: "string" }, inReplyTo: { type: "string" } },
    required: ["to", "subject", "body"],
  },
  requiredPermissions: ["gmail.send"],
  requiresConfirmation: true, // Never optional — sending email always requires approval, per the spec.
  async execute(parameters, context) {
    const result = await gmail.sendMessage(context.userId, parameters);
    return { messageId: result.id, threadId: result.threadId, sentTo: parameters.to };
  },
});

registerTool({
  name: "gmail.archive_email",
  description: "Archives an email (removes it from the inbox without deleting it).",
  category: "gmail",
  parameters: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  requiredPermissions: ["gmail.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    await gmail.archiveMessage(context.userId, parameters.messageId);
    return { messageId: parameters.messageId, archived: true };
  },
});

registerTool({
  name: "gmail.star_email",
  description: "Stars an email.",
  category: "gmail",
  parameters: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  requiredPermissions: ["gmail.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    await gmail.starMessage(context.userId, parameters.messageId);
    return { messageId: parameters.messageId, starred: true };
  },
});

registerTool({
  name: "gmail.trash_email",
  description: "Moves an email to trash.",
  category: "gmail",
  parameters: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
  requiredPermissions: ["gmail.read"],
  requiresConfirmation: true, // Deletion-adjacent — confirm even though Gmail trash is recoverable for a while.
  async execute(parameters, context) {
    await gmail.trashMessage(context.userId, parameters.messageId);
    return { messageId: parameters.messageId, trashed: true };
  },
});
