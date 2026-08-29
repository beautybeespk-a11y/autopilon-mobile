import * as meta from "../../integrations/meta/api.js";
import { getConnection, updateConnectionMeta } from "../../integrations/manager.js";

const PIXEL_ID_PATTERN = /^\d+$/;

export function isPlausiblePixelId(value) {
  return typeof value === "string" && PIXEL_ID_PATTERN.test(value);
}

// Same shape as metaAdAccountId.js's readSavedDefaultAdAccountId /
// metaPageId.js's readSavedDefaultPageId — a Default Pixel, saved under the
// SAME integrations.meta.defaults blob. Round 14 (live production trace):
// with no such mechanism, a genuinely ambiguous ad account (2+ Pixels, no
// explicit choice) had no deterministic way to auto-resolve at all.
function readSavedDefaultPixelId(conn) {
  const meta = JSON.parse(conn?.meta || "{}");
  return meta.defaults?.pixelId || null;
}

// A Pixel is optional for most campaign types — unlike resolvePageId()/
// resolveAdAccountId() (server/tools/shared/), which always require a
// real usable value, "no Pixel available" is a normal, valid outcome
// here, not an error. Only an EXPLICITLY supplied id that's fake or
// belongs to a different ad account throws — matching the same
// never-trust-shape-alone principle as resolveAdAccountId(): always
// cross-checked against a live meta.listPixels() call, not just format.
//
// Returns { pixelId, available } rather than throwing on "none" or
// "ambiguous, multiple available" — whether that blocks a plan depends on
// the campaign's optimization_event (Purchase-optimized campaigns need
// one, most others don't), which is a plan-validation decision
// (server/agents/metaExpert/planSchema.js), not this resolver's to make.
//
// Resolution order when no providedPixelId is supplied (mirrors
// resolveAdAccountId()/resolvePageId() exactly):
//   1. Exactly one Pixel available on this ad account → used automatically
//      (unchanged, pre-dates round 14).
//   2. A saved Default Pixel (userId's integrations.meta.defaults.pixelId),
//      only after confirming it's still among this ad account's real
//      Pixels — self-heals (clears) the same way a stale Default Ad
//      Account/Page does if it's gone. Only consulted when there's
//      genuine ambiguity (2+ available) — round 14, requirement 3.
//   3. Zero, or more than one with no usable default → { pixelId: null },
//      never a throw — the caller decides whether that blocks the plan.
// `userId` is optional — omitted, this behaves exactly as before (no
// default lookup).
export async function resolvePixelId({ accessToken, adAccountId, providedPixelId, userId }) {
  const available = await meta.listPixels(accessToken, adAccountId);

  if (providedPixelId) {
    if (!isPlausiblePixelId(providedPixelId)) {
      const err = new Error(`"${providedPixelId}" is not a real Meta Pixel id (must be numeric) — it looks like a placeholder. Don't invent one.`);
      err.code = "META_PIXEL_NOT_FOUND";
      throw err;
    }
    const match = available.find((p) => p.id === providedPixelId);
    if (match) return { pixelId: match.id, available };
    const err = new Error(
      `"${providedPixelId}" is not one of this ad account's Pixels. Available: ${available.map((p) => `${p.name} (${p.id})`).join(", ") || "(none)"}.`
    );
    err.code = "META_PIXEL_NOT_FOUND";
    throw err;
  }

  if (available.length === 1) return { pixelId: available[0].id, available };

  if (userId && available.length > 1) {
    const conn = getConnection(userId, "meta_ads");
    const savedDefault = readSavedDefaultPixelId(conn);
    if (savedDefault) {
      const stillValid = available.find((p) => p.id === savedDefault);
      if (stillValid) return { pixelId: stillValid.id, available };
      try {
        updateConnectionMeta(userId, "meta_ads", { defaults: { ...JSON.parse(conn.meta || "{}").defaults, pixelId: null } });
      } catch {
        // Non-fatal — resolution continues below regardless.
      }
    }
  }

  return { pixelId: null, available }; // none, or more than one with no explicit/default choice — the caller decides whether that matters
}
