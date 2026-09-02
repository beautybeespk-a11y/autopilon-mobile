// Meta Ads Expert V2 — creative content resolution for CAMPAIGN-mode
// strategies (Phase 1 follow-up: attach a real ad, not just a Campaign +
// Ad Set). Turns creative_strategy.source (a business decision the model
// already made, backend-validated by checkCreativeSourceAvailabilityPolicy/
// checkCreativeGroundingPolicy in policy.js) plus content_selector (the
// SAME ordinal/confirmed-id contract explicit_action mode already uses —
// see strategyBuilder.js's resolveContentSelector) into a real, verified
// piece of content or product image to attach — never invented, never
// guessed. Genuine ambiguity (2+ real candidates, no explicit pick) is
// surfaced as a real unresolved_questions entry naming the real
// candidates, exactly the resolution shape assetResolution.js already
// proved out for an ambiguous Pixel: explicit choice wins; then the prior
// strategy's ALREADY-RESOLVED choice is reused verbatim across revisions
// (never re-derived — the exact bug class that broke Pixel resolution
// three times in one session, see assetResolution.js's own comment); then
// the single available candidate auto-resolves; real ambiguity asks once.
//
// Deliberately UNLIKE Pixel/Page/AdAccount: a resolved creative choice is
// NEVER written back to the account-level defaults record
// (integrations.meta_ads.defaults). Pixel is one stable identity reused
// correctly across every future campaign; a chosen post or product image
// is specific to THIS strategy — silently replaying it on an unrelated
// future campaign would be a NEW bug, not a fix for the old one.
// Persistence here is scoped strictly to this strategy's own revisions
// (resolvedAssets.creative, reused via priorResolved), never further.
//
// GENERATED_IMAGE/GENERATED_VIDEO/USER_ATTACHED_MEDIA are explicitly out
// of scope this session (no copy generation, no chat-attachment bridge
// here) — a strategy may still recommend one of these as creative_strategy.
// source, but this resolver returns unsupportedSource:true for them so the
// executor can create the Campaign + Ad Set while honestly skipping the ad
// attach, rather than silently pretending it's not needed.
const OUT_OF_SCOPE_SOURCES = new Set(["GENERATED_IMAGE", "GENERATED_VIDEO", "USER_ATTACHED_MEDIA"]);

function eligibleFacebookCandidates(snapshot) {
  return (snapshot?.recentContent?.facebookPosts?.items || []).filter((i) => i.eligibleForPromotion);
}
function eligibleInstagramCandidates(snapshot) {
  return (snapshot?.recentContent?.instagramPosts?.items || []).filter((i) => i.eligibleForPromotion);
}
function eligibleProductCandidates(snapshot) {
  // A product with no real image can never become a PRODUCT_IMAGE ad —
  // never offered as a candidate, never silently substituted for one that
  // does have an image.
  return (snapshot?.business?.sampleProducts || []).filter((p) => p.imageUrl);
}

function candidatesForSource(source, snapshot) {
  if (source === "EXISTING_PAGE_POST") return eligibleFacebookCandidates(snapshot);
  if (source === "EXISTING_INSTAGRAM_POST") return eligibleInstagramCandidates(snapshot);
  if (source === "PRODUCT_IMAGE") return eligibleProductCandidates(snapshot);
  return [];
}

// A real, non-negotiable literal check — same principle as policy.js's
// userMessageContainsAmount for USER_PROVIDED budget: the model's own
// transcription of what the user said is never trusted on its own for a
// field that governs real ad copy. Normalizes whitespace/case only —
// never a fuzzy/semantic match, which could let something the user never
// actually wrote through. Exported for reuse by orchestrator/index.js's
// matchCreativeCandidateId, which needs the identical literal-substring
// discipline to match a candidate's displayed name/caption.
export function userMessageContainsText(userMessage, text) {
  if (!userMessage || typeof text !== "string" || !text.trim()) return false;
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(userMessage).includes(normalize(text));
}

// Resolves the ad's primaryText for a PRODUCT_IMAGE creative. Two real
// sources ONLY, checked in order — never model-authored copy (explicitly
// out of scope this session):
//   1. The product's own real shortDescription (WooCommerce short_
//      description / Shopify body_html — see businessSnapshot.js),
//      already HTML-stripped and truncated there.
//   2. A plain-language answer the user themselves typed THIS
//      conversation, verified to actually appear in their own raw
//      message (same "never trust the model's own claim" principle as
//      USER_PROVIDED budget) — asked for via a real unresolved_questions
//      entry (see strategyBuilder.js) when neither source has anything.
function resolvePrimaryText(product, strategy, userMessage) {
  if (product.shortDescription) return { primaryText: product.shortDescription, source: "product_short_description" };
  const answer = strategy.content_selector?.primaryTextAnswer;
  if (typeof answer === "string" && answer.trim() && userMessageContainsText(userMessage, answer)) {
    return { primaryText: answer.trim(), source: "user_supplied" };
  }
  return { primaryText: null, source: null };
}

// strategy: the normalized, merged strategy for THIS call (campaign mode
// only — explicit_action already has its own resolveContentSelector in
// strategyBuilder.js, untouched by this module).
// priorCreative: the PRIOR strategy's resolvedAssets.creative (or null on
// a fresh build) — the "already resolved, never re-derive" reuse case.
// contentSelectorProvidedThisCall: true when THIS call's raw (pre-merge)
// requestedChanges actually included a content_selector object — the
// signal that the user is explicitly (re-)picking creative this turn,
// exactly analogous to explicitAssetChanges for Pixel/Page/AdAccount.
export function resolveCreativeSelection({ strategy, snapshot, priorCreative, contentSelectorProvidedThisCall, userMessage }) {
  const source = strategy.creative_strategy?.source;
  const empty = { creative: null, ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false };
  if (strategy.mode === "explicit_action" || !source) return empty;

  if (OUT_OF_SCOPE_SOURCES.has(source)) {
    return { ...empty, unsupportedSource: true };
  }

  // Reuse verbatim — the prior strategy already resolved a creative for
  // the SAME source and nothing this call explicitly asked to change.
  // Never re-derived through the candidate list again (the exact bug
  // class fixed for Pixel — see this file's header comment).
  if (!contentSelectorProvidedThisCall && priorCreative && priorCreative.source === source) {
    return { creative: priorCreative, ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false };
  }

  const candidates = candidatesForSource(source, snapshot);
  if (!candidates.length) {
    // EXISTING_PAGE_POST/EXISTING_INSTAGRAM_POST with zero usable content
    // is ALREADY hard-rejected, with a richer, actionable message, by
    // checkCreativeSourceAvailabilityPolicy (policy.js) — deliberately not
    // duplicated here (a second, blander rejection for the same fact would
    // just be noise). Only PRODUCT_IMAGE has no earlier check for this,
    // since nothing previously required a real product image to exist at
    // all — zero real candidates is a structural gap, not a question the
    // user can answer by picking, so this is a genuine rejection here.
    if (source !== "PRODUCT_IMAGE") return empty;
    return {
      ...empty,
      creativeError: "creative_strategy claims a product image as the creative, but no product in the current snapshot has a real image to use — connect/verify a product image, or choose a different creative_strategy.source.",
    };
  }

  const selector = strategy.content_selector || {};
  let chosen = null;
  if (typeof selector.confirmedId === "string" && selector.confirmedId) {
    chosen = candidates.find((c) => c.id === selector.confirmedId);
    if (!chosen) {
      return { ...empty, creativeError: `"${selector.confirmedId}" is not one of the real creative candidates already shown this conversation — refer to it by the id shown, or by position (the first, the second, ...).` };
    }
  } else if (Number.isInteger(selector.position) && selector.position > 0) {
    chosen = candidates[selector.position - 1];
    if (!chosen) {
      return { ...empty, creativeError: `There is no creative candidate at position ${selector.position} — only ${candidates.length} real candidate(s) are available.` };
    }
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    // Genuine ambiguity — 2+ real candidates, no explicit pick. Never
    // guessed, never silently defaulted to "the first one." Surfaced by
    // the caller (strategyBuilder.js) as a real unresolved_questions
    // entry naming these exact candidates.
    return { ...empty, ambiguousCandidates: candidates };
  }

  if (source === "PRODUCT_IMAGE") {
    const { primaryText, source: primaryTextSource } = resolvePrimaryText(chosen, strategy, userMessage);
    if (!primaryText) {
      return { ...empty, needsPrimaryTextQuestion: true, ambiguousCandidates: [], creativeError: null, resolvedProductForQuestion: chosen };
    }
    return {
      creative: { source, productId: chosen.id, imageUrl: chosen.imageUrl, link: chosen.permalink, productName: chosen.name, primaryText, primaryTextSource },
      ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false,
    };
  }

  return { creative: { source, contentId: chosen.id }, ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false };
}

// Deterministic, backend-authored candidate list — NEVER model text, so
// there's no surface for an unsupported "best performing" claim to sneak
// in here (see checkCreativeGroundingPolicy in policy.js for the
// strategy-text-level enforcement of that same rule). Real ids, real
// captions/product names, and REAL engagement numbers only when the
// snapshot actually returned them — otherwise explicitly "no engagement
// data available," never omitted (which could read as "doesn't exist").
export function formatCreativeCandidatesQuestion(source, candidates) {
  const label = { EXISTING_PAGE_POST: "Facebook post", EXISTING_INSTAGRAM_POST: "Instagram post", PRODUCT_IMAGE: "product" }[source] || "item";
  const parts = candidates.map((c, i) => {
    const n = i + 1;
    if (source === "PRODUCT_IMAGE") {
      return `${n}) "${c.name}" (id ${c.id}${c.price ? `, ${c.price}` : ""})`;
    }
    const excerpt = c.captionExcerpt ? `"${c.captionExcerpt}"` : "(no caption)";
    const engagementNote = c.engagement?.status === "exists"
      ? `${c.engagement.likes ?? 0} likes/${c.engagement.comments ?? 0} comments`
      : "no engagement data available";
    return `${n}) ${excerpt} (id ${c.id}, posted ${c.publishedDate || "unknown date"}, ${engagementNote})`;
  });
  return `Which ${label} should I use as the ad's creative? ${parts.join(" ")} — reply with the number, or describe which one.`;
}

export function formatPrimaryTextQuestion(product) {
  return `What ad text would you like for the "${product.name}" image ad? This product has no description to pull from automatically — reply with the exact text you'd like used, and I'll use it exactly as written.`;
}
