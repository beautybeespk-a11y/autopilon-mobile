import db from "../../../db.js";
import { decryptSecret } from "../../../orchestrator/secretsCrypto.js";
import { logger } from "../../../config/logger.js";

// WhatsApp's webhook is registered once per Meta App, not per user — every
// connected user's messages arrive at the same URL. This looks up which of
// our users owns the phone_number_id a given webhook event is for, by
// matching it against the `meta` JSON stored on their `integrations` row
// (provider='whatsapp'). Queries the table directly rather than going
// through integrations/manager.js's getConnection() (which needs a userId
// up front — the whole point here is finding the userId from the
// phoneNumberId instead), so it decrypts accessToken itself (Phase 18.1
// §1) rather than relying on manager.js's centralized decryption.
export function findOwnerByPhoneNumberId(phoneNumberId) {
  const rows = db.prepare("SELECT userId, accessToken, meta FROM integrations WHERE provider = 'whatsapp' AND status = 'connected'").all();
  for (const row of rows) {
    const meta = JSON.parse(row.meta || "{}");
    if (meta.phoneNumberId === phoneNumberId) {
      let accessToken = null;
      try {
        accessToken = row.accessToken ? decryptSecret(row.accessToken) : null;
      } catch (err) {
        logger.warn("whatsapp.owner_token_decrypt_failed", { userId: row.userId, reason: err.message });
      }
      return { userId: row.userId, accessToken, meta };
    }
  }
  return null;
}
