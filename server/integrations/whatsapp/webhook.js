// Meta's webhook payload is deeply nested and can contain multiple entries/
// changes/messages in one call. This flattens it into simple event objects
// the rest of the app can work with, and never throws on a shape it doesn't
// recognize — unsupported message types are returned as `type: "unsupported"`
// rather than causing a crash.

const SUPPORTED_TYPES = new Set(["text", "image", "document", "location", "audio", "video", "sticker"]);

export function parseWebhookPayload(body) {
  const events = [];
  const entries = body?.entry || [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;

      for (const msg of value.messages || []) {
        events.push({
          kind: "message",
          phoneNumberId,
          from: msg.from,
          waMessageId: msg.id,
          timestamp: msg.timestamp,
          type: SUPPORTED_TYPES.has(msg.type) ? msg.type : "unsupported",
          rawType: msg.type,
          text: msg.text?.body,
          media: msg.image || msg.document || msg.audio || msg.video || msg.sticker || null,
          location: msg.location || null,
        });
      }

      for (const status of value.statuses || []) {
        events.push({
          kind: "status",
          phoneNumberId,
          waMessageId: status.id,
          status: status.status, // sent | delivered | read | failed
          timestamp: status.timestamp,
        });
      }

      if (value.errors?.length) {
        for (const error of value.errors) {
          events.push({ kind: "error", phoneNumberId, message: error.message, code: error.code });
        }
      }
    }
  }

  return events;
}
