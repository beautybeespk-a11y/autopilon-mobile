// Conversation-scoped Meta asset selections (Issue 1 / Issue 4 — live
// testing round 3). Once an ad account, Page, Pixel, catalog, or Instagram
// identity has been resolved for a conversation (whether picked explicitly
// by the user or auto-resolved because only one existed), it's remembered
// for the REST of that conversation — including revisions — so the same
// question is never asked twice and a later plan can't silently drift onto
// a different Page/account than the one already in use.
//
// This is a hint, not a trust boundary: every value read back from here
// still goes through the same live-Meta-cross-check resolvers
// (server/tools/shared/*) before being used — see resolveWithMemory() in
// planner.js. If Meta no longer recognizes a saved id (removed, access
// revoked), it's cleared here and resolution falls through to asking
// again, exactly like a saved Default Ad Account would.
import db from "../../db.js";

const FIELD_TO_COLUMN = {
  adAccount: "selectedAdAccountId",
  facebookPage: "selectedFacebookPageId",
  pixel: "selectedPixelId",
  catalog: "selectedCatalogId",
  instagram: "selectedInstagramId",
};

export function getConversationAssets(conversationId) {
  if (!conversationId) return {};
  const row = db.prepare("SELECT * FROM meta_conversation_assets WHERE conversationId = ?").get(conversationId);
  return row || {};
}

export function saveConversationAsset(conversationId, userId, field, id) {
  if (!conversationId || !id) return;
  const column = FIELD_TO_COLUMN[field];
  if (!column) throw new Error(`Unknown conversation asset field "${field}"`);
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT conversationId FROM meta_conversation_assets WHERE conversationId = ?").get(conversationId);
  if (existing) {
    db.prepare(`UPDATE meta_conversation_assets SET ${column} = ?, updatedAt = ? WHERE conversationId = ?`).run(id, now, conversationId);
  } else {
    db.prepare(`INSERT INTO meta_conversation_assets (conversationId, userId, ${column}, updatedAt) VALUES (?, ?, ?, ?)`).run(conversationId, userId, id, now);
  }
}

export function clearConversationAsset(conversationId, field) {
  if (!conversationId) return;
  const column = FIELD_TO_COLUMN[field];
  if (!column) return;
  db.prepare(`UPDATE meta_conversation_assets SET ${column} = NULL WHERE conversationId = ?`).run(conversationId);
}
