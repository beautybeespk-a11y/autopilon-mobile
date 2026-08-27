import * as meta from "../../integrations/meta/api.js";

const PIXEL_ID_PATTERN = /^\d+$/;

export function isPlausiblePixelId(value) {
  return typeof value === "string" && PIXEL_ID_PATTERN.test(value);
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
export async function resolvePixelId({ accessToken, adAccountId, providedPixelId }) {
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
  return { pixelId: null, available }; // none, or more than one with no explicit choice — the caller decides whether that matters
}
