import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

// Shared by routes/voice.js and contentService.js's voiceover generation —
// one insert path into voice_usage, so a voiceover generated through the
// Content Studio shows up in the exact same usage/billing accounting as a
// spoken chat reply (Phase 15 spec: voiceover must integrate with the
// EXISTING Voice system, and all voice usage must pass through existing
// usage/billing — not a second accounting path).
export function resolveOrgId(userId) {
  const row = db.prepare("SELECT orgId FROM organization_members WHERE userId = ? AND status != 'suspended' ORDER BY joinedAt ASC LIMIT 1").get(userId);
  return row?.orgId || null;
}

export function recordVoiceUsage({ userId, kind, provider, durationSeconds, characters, estimatedCostCents, agentId, conversationId }) {
  db.prepare(
    `INSERT INTO voice_usage (id, userId, orgId, agentId, conversationId, kind, provider, durationSeconds, characters, estimatedCostCents, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    cryptoRandom(), userId, resolveOrgId(userId), agentId || null, conversationId || null,
    kind, provider, durationSeconds ?? null, characters ?? null, estimatedCostCents, new Date().toISOString()
  );
}

// tts-1: $15 per 1M characters — same estimate routes/voice.js already uses.
export const TTS_CENTS_PER_CHAR = 1500 / 1_000_000;
