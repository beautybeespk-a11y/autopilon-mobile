import db from "../../../db.js";

// WhatsApp's webhook is registered once per Meta App, not per user — every
// connected user's messages arrive at the same URL. This looks up which of
// our users owns the phone_number_id a given webhook event is for, by
// matching it against the `meta` JSON stored on their `integrations` row
// (provider='whatsapp').
export function findOwnerByPhoneNumberId(phoneNumberId) {
  const rows = db.prepare("SELECT userId, accessToken, meta FROM integrations WHERE provider = 'whatsapp' AND status = 'connected'").all();
  for (const row of rows) {
    const meta = JSON.parse(row.meta || "{}");
    if (meta.phoneNumberId === phoneNumberId) {
      return { userId: row.userId, accessToken: row.accessToken, meta };
    }
  }
  return null;
}
