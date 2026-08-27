import * as meta from "../../integrations/meta/api.js";

const CATALOG_ID_PATTERN = /^\d+$/;

export function isPlausibleCatalogId(value) {
  return typeof value === "string" && CATALOG_ID_PATTERN.test(value);
}

// Same reasoning and shape as resolvePixelId() — a product catalog is only
// relevant for catalog/dynamic-ad campaigns, so "none available" is a
// normal outcome, not an error. Only a fake or wrong explicit id throws,
// always cross-checked against a live meta.listCatalogs() call.
export async function resolveCatalogId({ accessToken, adAccountId, providedCatalogId }) {
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
  return { catalogId: null, available };
}
