import fs from "fs";
import db from "../../db.js";

// Same knowledge_items lookup + userId scoping conversationService.js uses
// to hand the model a chat-attached photo as a vision input for that turn —
// re-read here because a tool's execute() only ever receives
// {userId, agentId}, nothing about the message that triggered the turn.
// Shared by any tool that needs to turn "the photo the user just attached"
// into real bytes it can upload somewhere (wordpress.upload_chat_image,
// meta.create_image_ad).
export function resolveChatImage(userId, imageReferenceId) {
  const row = db.prepare("SELECT content FROM knowledge_items WHERE id = ? AND userId = ? AND type = 'image'").get(imageReferenceId, userId);
  if (!row) {
    const err = new Error("That attached photo wasn't found — it may belong to a different conversation or account.");
    err.code = "NOT_FOUND";
    throw err;
  }
  const meta = JSON.parse(row.content || "{}");
  if (!meta.storagePath || !fs.existsSync(meta.storagePath)) {
    const err = new Error("That attached photo's file is no longer available.");
    err.code = "NOT_FOUND";
    throw err;
  }
  return { buffer: fs.readFileSync(meta.storagePath), mimeType: meta.mimeType || "image/jpeg" };
}
