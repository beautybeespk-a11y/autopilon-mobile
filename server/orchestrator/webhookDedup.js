import db from "../db.js";

// Dedupes webhook deliveries across every external source that can
// redeliver the same event — Meta/WhatsApp does it, and so does Stripe.
// Extracted from integrations/whatsapp/services/conversationResolver.js
// (which used this exact function, INSERT-first-wins against the same
// webhook_events table) so other webhook routes can reuse it instead of
// each one growing its own ad-hoc dedup logic.
//
// `id` should be namespaced per source (e.g. `stripe:${event.id}`) since
// webhook_events.id is a single flat primary key with no separate source
// column — two sources could otherwise coincidentally collide on a raw id.
export function isDuplicateEvent(id, eventType) {
  try {
    db.prepare("INSERT INTO webhook_events (id, eventType, receivedAt) VALUES (?, ?, ?)")
      .run(id, eventType, new Date().toISOString());
    return false;
  } catch {
    return true; // primary key collision — this exact event was already recorded
  }
}
