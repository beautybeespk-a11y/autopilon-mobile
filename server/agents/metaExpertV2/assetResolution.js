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
import { getConnection, updateConnectionMeta } from "../../integrations/manager.js";

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
        // Round 31 fixed "revise_strategy never gets called for a plain-
        // chat Pixel answer" by adding the orchestrator's deterministic
        // digit-run auto-revise pre-loop (index.js) — a real id verified
        // against the user's OWN raw message before revise_strategy is
        // ever called. Its accompanying assetResolution.js change,
        // though, went further: it bypassed the explicitAssetChanges gate
        // entirely for genuine ambiguity (priorResolved.pixelId null),
        // reasoning that the gate "has nothing to protect yet." That
        // reasoning missed that the gate is ALSO the only thing standing
        // between the tool contract's own documented promise —
        // tools/meta/metaExpertV2.js: "a REAL id is only ever honored as
        // the user's explicit choice when its field name is also listed
        // in explicitAssetChanges" — and a MODEL-initiated revise_strategy
        // call that puts a pixel ref in requestedChanges without the user
        // ever having confirmed it via their own message (the model has
        // pixel id+name in the business snapshot and can reach for one on
        // its own reasoning). CONFIRMED LIVE (round 33, user's own
        // diagnosis): the wrong candidate — a real, connected Pixel, just
        // not the one that actually received Purchase events — was
        // permanently saved as the account-level default this way.
        //
        // Fixed by making the ONE trusted caller satisfy the gate instead
        // of removing it: the orchestrator's pixel auto-revise pre-loop
        // now passes explicitAssetChanges: ["pixel"] itself (index.js) —
        // it has genuine grounds to (a real id, verified unambiguous
        // against the raw userMessage), so the ordinary gate below is all
        // that's needed. No other caller, model included, gets a REAL id
        // honored here without also declaring explicitAssetChanges —
        // restoring the documented contract for every caller, not just
        // this one. A model call that skips the flag now falls through to
        // normal resolution (ambiguous → re-asks the same open question,
        // same as any other unresolved ambiguity) rather than being
        // silently accepted — never a silent wrong answer, at the cost of
        // needing the deterministic pre-loop (or an explicit-flag model
        // call) to actually resolve a purely-natural-language answer that
        // never named a digit the pre-loop's own matcher recognizes.
        const explicitId = explicitAssetRef(strategy.pixel, "pixel", explicitAssetChanges);
        const { pixelId, available } = await resolvePixelId({ accessToken, adAccountId: resolved.adAccountId, providedPixelId: explicitId, userId });
        resolved.pixelId = pixelId;
        availablePixels = available;
        // Live design fix (round 31, user's own diagnosis): the connection-
        // level Default Pixel (integrations.meta_ads.defaults.pixelId —
        // the SAME record resolvePixelId already reads at priority 2,
        // above) has always been readable but never WRITABLE from this
        // chat flow — every ambiguous-Pixel resolution lived only on one
        // strategy row, re-derived through merge logic on every revision,
        // which is what made a real answer this fragile to lose across
        // three separate incidents this session. Fixed at the actual
        // design level: the moment a genuinely explicit, gate-satisfying
        // answer resolves a GENUINE ambiguity (priorResolved.pixelId was
        // null — nothing was already saved to protect or override), it's
        // written back to the SAME saved-default record permanently.
        // Every future build_strategy — in this conversation or any other
        // — then resolves the Pixel at the resolver's own existing
        // priority-2 step, before ambiguity is even possible, and never
        // asks again. Never overwrites an existing DELIBERATE default
        // just because a strategy is reusing it (priorResolved.pixelId
        // already truthy takes the reuse branch above, never reaching
        // here) or picking a different one for one specific campaign
        // while a default remains set.
        if (explicitId && pixelId && !priorResolved?.pixelId && userId) {
          try {
            const conn = getConnection(userId, "meta_ads");
            const currentDefaults = JSON.parse(conn?.meta || "{}").defaults || {};
            if (currentDefaults.pixelId !== pixelId) {
              updateConnectionMeta(userId, "meta_ads", { defaults: { ...currentDefaults, pixelId } });
            }
          } catch {
            // Best-effort — the strategy's own resolution above already
            // succeeded regardless; only the "never ask again" durability
            // is lost if this fails, not this strategy's correctness.
          }
        }
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
  // Persisted on `resolved` (unlike availablePixels itself, which is only
  // ever used transiently within this call — see strategyBuilder.js's own
  // ambiguous-Pixel unresolved_questions injection) so it survives into
  // the stored strategy row via insertStrategy's resolvedAssets spread.
  // Lets the orchestrator's pixel auto-revise (round 31) recognize a REAL
  // candidate id the user names in plain chat without an extra live
  // meta.listPixels() call of its own, and without ever guessing — only
  // ids Meta itself already confirmed exist on this ad account.
  resolved.pixelCandidates = pixelAmbiguous ? availablePixels.map((p) => p.id) : null;

  return { resolved, names, resolutionErrors, availablePixels, anyPixelExists, usablePixelForSelectedAdAccount, pixelAmbiguous };
}
