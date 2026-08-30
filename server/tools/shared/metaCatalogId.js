import * as meta from "../../integrations/meta/api.js";
import { getConnection, updateConnectionMeta } from "../../integrations/manager.js";

const CATALOG_ID_PATTERN = /^\d+$/;

export function isPlausibleCatalogId(value) {
  return typeof value === "string" && CATALOG_ID_PATTERN.test(value);
}

// Same shape as metaPixelId.js's readSavedDefaultPixelId — a Default
// Catalog, saved under the same integrations.meta.defaults blob (added for
// Meta Ads Expert V2, server/agents/metaExpertV2/ — Step 2's default asset
// policy explicitly lists a Default Catalog alongside ad account/Page/
// Pixel/Instagram).
function readSavedDefaultCatalogId(conn) {
  const meta = JSON.parse(conn?.meta || "{}");
  return meta.defaults?.catalogId || null;
}

// Same reasoning and shape as resolvePixelId() — a product catalog is only
// relevant for catalog/dynamic-ad campaigns, so "none available" is a
// normal outcome, not an error. Only a fake or wrong explicit id throws,
// always cross-checked against a live meta.listCatalogs() call.
// `userId` is optional — omitted, this behaves exactly as before (no
// default lookup, existing callers unaffected).
export async function resolveCatalogId({ accessToken, adAccountId, providedCatalogId, userId }) {
  const available = await meta.listCatalogs(accessToken, adAccountId);

  if (providedCatalogId) {
    if (!isPlausibleCatalogId(providedCatalogId)) {
      const err = new Error(`"${providedCatalogId}" is not a real Meta catalog id (must be numeric) — it looks like a placeholder. Don't invent one.`);
      err.code = "META_CATALOG_NOT_FOUND";
      throw err;
    }
    const match = available.find((c) => c.id === providedCatalogId);
    if (match) return { catalogId: match.id, available };
    const err = new Error(
      `"${providedCatalogId}" is not one of this ad account's catalogs. Available: ${available.map((c) => `${c.name} (${c.id})`).join(", ") || "(none)"}.`
    );
    err.code = "META_CATALOG_NOT_FOUND";
    throw err;
  }

  if (available.length === 1) return { catalogId: available[0].id, available };

  if (userId && available.length > 1) {
    const conn = getConnection(userId, "meta_ads");
    const savedDefault = readSavedDefaultCatalogId(conn);
    if (savedDefault) {
      const stillValid = available.find((c) => c.id === savedDefault);
      if (stillValid) return { catalogId: stillValid.id, available };
      try {
        updateConnectionMeta(userId, "meta_ads", { defaults: { ...JSON.parse(conn.meta || "{}").defaults, catalogId: null } });
      } catch {
        // Non-fatal — resolution continues below regardless.
      }
    }
  }

  return { catalogId: null, available };
}
