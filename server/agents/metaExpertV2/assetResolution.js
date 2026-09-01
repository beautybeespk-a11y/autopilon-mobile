// Meta Ads Expert V2 — turns a strategy's SEMANTIC asset references
// ("default_ad_account", or a real id the user already explicitly
// confirmed this conversation) into real, verified Meta ids (Step 2).
//
// Deliberately composes the EXISTING, already-proven deterministic
// resolvers (server/tools/shared/metaAdAccountId.js, metaPageId.js,
// metaPixelId.js, metaCatalogId.js) rather than reimplementing asset
// resolution from scratch — "keep existing deterministic ID resolvers
// where they are proven and useful." Each one already implements exactly
// the priority order Step 2 specifies for a NEW strategy: an explicit,
// verified id wins; then a saved Default (Integrations settings), self-
// healing if it's gone stale; then the single connected asset if there's
// only one; then genuine ambiguity is surfaced rather than guessed.
//
// The LLM never supplies a raw id as authoritative — only a semantic ref
// ("default_ad_account") or, when it names a REAL id, that's only trusted
// as the user's actual explicit choice when the caller has separately
// declared that field is changing (explicitAssetChanges) — never just
// because the model happened to emit a real-shaped id on its own.
import * as meta from "../../integrations/meta/api.js";
import { resolveAdAccountId } from "../../tools/shared/metaAdAccountId.js";
import { resolvePageId } from "../../tools/shared/metaPageId.js";
import { resolvePixelId } from "../../tools/shared/metaPixelId.js";
import { resolveCatalogId } from "../../tools/shared/metaCatalogId.js";
import { PURCHASE_LIKE_EVENTS } from "./strategySchema.js";

const SEMANTIC_REFS = new Set(["default_ad_account", "default_facebook_page", "default_instagram_identity", "default_pixel", "default_catalog"]);

// A real, non-semantic ref value (never a bare id trusted just because the
// model happened to emit one — see the module comment at the top of this
// file) — used both as the ordinary explicitAssetChanges-gated case below
// and, for pixel only, as the ungated fallback (see its call site).
function realAssetRef(refObj) {
  const ref = refObj?.ref;
  if (!ref || SEMANTIC_REFS.has(ref)) return undefined;
  return ref;
}
function explicitAssetRef(refObj, field, explicitAssetChanges) {
  const ref = realAssetRef(refObj);
  return ref && explicitAssetChanges.has(field) ? ref : undefined;
}

function nameFrom(list, id) {
  return list.find((item) => item.id === id)?.name || null;
}

// Live bug (round 30): the resolved ad account's real currency was never
// captured anywhere at build/revise time — see businessSnapshot.js. Reads
// from the SAME accounts list nameFrom() above already resolves against
// (now including currency), so no extra API call.
function currencyFrom(list, id) {
  return list.find((item) => item.id === id)?.currency || null;
}

// priorResolved/explicitAssetChanges (only present on a revision): Step
// 2's REVISION priority — 1. prior strategy's resolved asset (reused
// DIRECTLY, no re-resolution, no network call) unless explicitAssetChanges
// says the user asked to change it THIS turn, in which case it falls
// through to the normal NEW-strategy resolution order below (explicit >
// saved default > single > ask).
export async function resolveStrategyAssets(strategy, { userId, accessToken, priorResolved = null, explicitAssetChanges = new Set(), snapshot = null }) {
  const resolved = { adAccountId: null, pageId: null, instagramId: null, pixelId: null, catalogId: null };
  const names = { adAccountName: null, adAccountCurrency: null, pageName: null, instagramUsername: null };
  const resolutionErrors = [];

  let adAccountReused = false;
  if (priorResolved?.adAccountId && !explicitAssetChanges.has("ad_account")) {
    resolved.adAccountId = priorResolved.adAccountId;
    names.adAccountName = priorResolved.adAccountName || null;
    names.adAccountCurrency = priorResolved.adAccountCurrency || null;
    adAccountReused = true;
  } else {
    try {
      const explicitId = explicitAssetRef(strategy.ad_account, "ad_account", explicitAssetChanges);
      resolved.adAccountId = await resolveAdAccountId({ userId, accessToken, providedAdAccountId: explicitId });
      const accounts = snapshot?.metaAssets?.adAccounts?.items || (await meta.listAdAccounts(accessToken).catch(() => []));
      names.adAccountName = nameFrom(accounts, resolved.adAccountId);
      names.adAccountCurrency = currencyFrom(accounts, resolved.adAccountId);
    } catch (err) {
      resolutionErrors.push({ field: "ad_account", message: err.message, code: err.code });
    }
  }

  let pageReused = false;
  if (priorResolved?.pageId && !explicitAssetChanges.has("facebook_page")) {
    resolved.pageId = priorResolved.pageId;
    names.pageName = priorResolved.pageName || null;
    pageReused = true;
  } else {
    try {
      const explicitId = explicitAssetRef(strategy.facebook_page, "facebook_page", explicitAssetChanges);
      resolved.pageId = await resolvePageId({ accessToken, providedPageId: explicitId, userId });
      const pages = snapshot?.metaAssets?.pages?.items || (await meta.listPages(accessToken).catch(() => []));
      names.pageName = nameFrom(pages, resolved.pageId);
    } catch (err) {
      resolutionErrors.push({ field: "facebook_page", message: err.message, code: err.code });
    }
  }

  if (resolved.pageId) {
    if (priorResolved?.instagramId && pageReused && !explicitAssetChanges.has("instagram_identity")) {
      resolved.instagramId = priorResolved.instagramId;
      names.instagramUsername = priorResolved.instagramUsername || null;
    } else if (strategy.instagram_identity || strategy.mode === "explicit_action") {
      resolved.instagramId = await meta.getInstagramAccountId(accessToken, resolved.pageId).catch(() => null);
    }
  }

  // Attempted whenever the strategy references a pixel OR the
  // optimization event needs one to be measured — a strategy that picks
  // PURCHASE optimization but forgets to also set strategy.pixel shouldn't
  // skip this check just because it forgot a related field.
  let availablePixels = [];
  if ((strategy.pixel || PURCHASE_LIKE_EVENTS.has(strategy.optimization_event) || strategy.mode === "explicit_action") && resolved.adAccountId) {
    if (priorResolved?.pixelId && adAccountReused && !explicitAssetChanges.has("pixel")) {
      resolved.pixelId = priorResolved.pixelId;
    } else {
      try {
        // Live bug (round 31): a genuinely AMBIGUOUS prior Pixel
        // (priorResolved.pixelId null — nothing was ever actually
        // resolved, only a real unresolved_questions entry asking which
        // one) has nothing for the ordinary explicitAssetChanges gate to
        // protect — that gate exists specifically to stop an ALREADY-
        // resolved asset from being silently reassigned just because the
        // model restated it in prose (round 11), which cannot apply when
        // nothing was resolved yet. Requiring the model to ALSO remember
        // explicitAssetChanges:["pixel"] on top of directly answering the
        // question it was just asked produced a genuine live infinite
        // loop: the model called revise_strategy with the user's chosen
        // Pixel id, said "updated," but the backend silently dropped the
        // id (explicitAssetChanges wasn't set), re-resolved into the SAME
        // ambiguity, and re-asked the SAME question forever. A real,
        // non-semantic ref is honored here whenever there was genuinely
        // nothing resolved to protect — never for an already-resolved
        // Pixel, where the ordinary gated path below still applies.
        const explicitId = explicitAssetRef(strategy.pixel, "pixel", explicitAssetChanges) || (!priorResolved?.pixelId ? realAssetRef(strategy.pixel) : undefined);
        const { pixelId, available } = await resolvePixelId({ accessToken, adAccountId: resolved.adAccountId, providedPixelId: explicitId, userId });
        resolved.pixelId = pixelId;
        availablePixels = available;
      } catch (err) {
        resolutionErrors.push({ field: "pixel", message: err.message, code: err.code });
      }
    }
  } else if (resolved.adAccountId) {
    // Existence-only check (never blocks anything by itself) — needed so
    // businessSignals.clearEcommerceWithPurchaseTracking (policy.js) can
    // tell "a Pixel exists on this ad account" apart from "one was
    // actually resolved for THIS strategy", even for a strategy that
    // doesn't reference Purchase optimization (Step 4: a Traffic strategy
    // for an e-commerce business with real tracking must still trigger the
    // goal-alignment gate).
    try {
      ({ available: availablePixels } = await resolvePixelId({ accessToken, adAccountId: resolved.adAccountId, userId }));
    } catch {
      // Best-effort signal only.
    }
  }

  if (strategy.catalog?.ref && resolved.adAccountId) {
    if (priorResolved?.catalogId && adAccountReused && !explicitAssetChanges.has("catalog")) {
      resolved.catalogId = priorResolved.catalogId;
    } else {
      try {
        const explicitId = explicitAssetRef(strategy.catalog, "catalog", explicitAssetChanges);
        resolved.catalogId = await resolveCatalogId({ accessToken, adAccountId: resolved.adAccountId, providedCatalogId: explicitId, userId }).then((r) => r.catalogId);
      } catch (err) {
        resolutionErrors.push({ field: "catalog", message: err.message, code: err.code });
      }
    }
  }

  const anyPixelExists = !!resolved.pixelId || availablePixels.length > 0;
  const usablePixelForSelectedAdAccount = !!resolved.pixelId;
  const pixelAmbiguous = !resolved.pixelId && availablePixels.length > 1;

  return { resolved, names, resolutionErrors, availablePixels, anyPixelExists, usablePixelForSelectedAdAccount, pixelAmbiguous };
}
