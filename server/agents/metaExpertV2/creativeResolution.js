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

// Round 48 — carousel ads (one ad, up to MAX_CAROUSEL_CARDS cards, each a
// different real product). Meta's own documented minimum for a standard
// link_data carousel — unverified independently this round (the 2-card
// shape itself WAS verified live against Meta's real API; this floor is
// the long-standing documented minimum, not separately tested).
export const MIN_CAROUSEL_CARDS = 2;
// Meta's documented maximum for a standard link_data carousel — also not
// independently verified this round (flagged explicitly rather than
// assumed). Enforced here so an oversized request is refused with a
// clear, citable reason BEFORE ever reaching Meta — never silently
// truncated, which would drop a product the user explicitly asked for
// with no mention of the drop. If this number is ever wrong, Meta's own
// rejection at execution time (executor.js) surfaces verbatim — this cap
// is a courtesy that fails loudly, not the only guard.
export const MAX_CAROUSEL_CARDS = 10;

// Independent, per-card verification (round 48) — same PURPOSE as
// matchCreativeCandidateId's verification of a single pick (round 34:
// never trust a model-asserted selection without checking it against the
// user's own raw words), but deliberately NOT the same function: a
// carousel's full-list-resend contract (see resolveCarouselSelection
// below) means several cards can change in ONE message ("swap 3 and 7"),
// and matchCreativeCandidateId's own "2+ matches anywhere in the
// candidate list means stop, don't guess" rule — exactly right for a
// SINGLE pick — would make an unrelated SECOND real product name anywhere
// in the message block verification of a card that's otherwise completely
// unambiguous on its own. This checks only "does THIS card's own id or
// name appear in the message" — nothing about any other candidate. No
// position/ordinal matching here — "2)" is already meaningless once a
// card's CARD-LIST position, not the ORIGINAL candidate list position, is
// what the user is really pointing at; id or literal product name are the
// only unambiguous signals for an individual carousel card.
function cardIsVerifiedInMessage(userMessage, candidate) {
  if (typeof userMessage !== "string" || !candidate) return false;
  if (/^\d+$/.test(candidate.id)) {
    const digitRuns = userMessage.match(/\d+/g) || [];
    if (digitRuns.includes(candidate.id)) return true;
  } else if (userMessage.includes(candidate.id)) {
    return true;
  }
  return userMessageContainsText(userMessage, candidate.name);
}

// Resolves ONE requested carousel card entry ({confirmedId} or
// {position}) against the REAL, image-eligible candidates — same
// never-guess discipline as the single-pick path's confirmedId/position
// branches, just returning an {error}/{candidate} result instead of
// throwing, so the caller can report exactly which card (by its position
// in the REQUESTED list) failed. allProducts (the full, UN-filtered
// sampleProducts list) is passed separately so a product that's real but
// has no image gets its own specific, honest rejection — naming the
// product and the real reason — rather than the generic "not a real
// candidate" message a merely-invented id gets.
function resolveCarouselCardEntry(entry, candidates, allProducts) {
  if (typeof entry.confirmedId === "string" && entry.confirmedId) {
    const found = candidates.find((c) => c.id === entry.confirmedId);
    if (found) return { candidate: found };
    const existsButNoImage = (allProducts || []).find((p) => p.id === entry.confirmedId && !p.imageUrl);
    if (existsButNoImage) {
      return { error: `"${existsButNoImage.name}" (id ${existsButNoImage.id}) has no real product image in the current snapshot, so it can't be used as a carousel card. Add a real image to that product first, or choose a different one.` };
    }
    return { error: `"${entry.confirmedId}" is not one of the real product candidates already shown this conversation.` };
  }
  if (Number.isInteger(entry.position) && entry.position > 0) {
    const found = candidates[entry.position - 1];
    if (!found) return { error: `There is no product candidate at position ${entry.position} — only ${candidates.length} real candidate(s) are available.` };
    return { candidate: found };
  }
  return { error: "Each carousel card must be chosen by a real confirmedId or a real list position — never invented." };
}

// content_selector for a carousel carries the WHOLE card list every call
// (see this module's header-adjacent comment on resolveCarouselSelection
// below for why) — either positions (ordinal, into the current candidate
// list) or confirmedIds (real product ids already shown), never mixed.
// Returns null when neither is present at all — the caller's own signal
// to auto-propose the deterministic default instead of treating this as a
// (rejected) explicit empty list.
function extractCarouselEntries(selector) {
  if (Array.isArray(selector.confirmedIds)) return selector.confirmedIds.map((id) => ({ confirmedId: id }));
  if (Array.isArray(selector.positions)) return selector.positions.map((p) => ({ position: p }));
  return null;
}

// strategy/snapshot/priorCreative/contentSelectorProvidedThisCall/userMessage
// — same meaning as resolveCreativeSelection's own params (this is called
// FROM there, never directly). priorCreative here is specifically the
// PRIOR strategy's resolvedAssets.creative — {source, layout, cards} on
// carousel reuse, or null/single-shaped otherwise; only ever read as
// carousel-shaped after confirming layout === "CAROUSEL" below, so a
// single-card creative from BEFORE this strategy switched to carousel (or
// vice versa) is never misread as a partial card list.
//
// Full-list-resend contract (explicit design decision, confirmed before
// building this): every call that changes the carousel's cards resends
// the COMPLETE ordered list — e.g. "replace 4 with the CeraVe cleanser"
// means the model sends all 10 entries, 9 identical to what's already
// stored and one different — rather than this function trying to merge a
// sparse by-position edit onto the prior list itself. This is simpler and
// strictly safer than inventing partial-merge machinery: every entry that
// ACTUALLY differs from the prior stored list is independently verified
// against the user's own raw words (cardIsVerifiedInMessage above) before
// being trusted; every entry that's byte-identical to what's already
// there is treated as a carried-forward, already-verified fact — exactly
// mirroring the single-pick path's own reuse-verbatim vs re-verify split,
// just applied per-card instead of to one whole value.
export function resolveCarouselSelection({ strategy, snapshot, priorCreative, contentSelectorProvidedThisCall, userMessage }) {
  const empty = { creative: null, ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false, pendingCreative: null };

  // Reuse verbatim — the prior strategy already resolved a carousel and
  // nothing this call explicitly asked to change. Never re-derived (the
  // same bug class fixed for Pixel and for the single-card creative path).
  if (!contentSelectorProvidedThisCall && priorCreative?.source === "PRODUCT_IMAGE" && priorCreative?.layout === "CAROUSEL") {
    return { ...empty, creative: priorCreative };
  }

  const candidates = eligibleProductCandidates(snapshot);
  if (candidates.length < MIN_CAROUSEL_CARDS) {
    return {
      ...empty,
      creativeError: `A carousel needs at least ${MIN_CAROUSEL_CARDS} products with a real image — only ${candidates.length} currently ${candidates.length === 1 ? "has" : "have"} one in the connected store. Add images to more products, or use creative_strategy.layout "SINGLE" for a one-product ad instead.`,
    };
  }

  const selector = strategy.content_selector || {};
  const entries = extractCarouselEntries(selector);

  let chosenCandidates;
  let defaultProposed = false;
  if (!entries) {
    // No explicit list at all — the deterministic, STATED-rule default:
    // the N most recent image-eligible products. candidates is already
    // most-recent-first (businessSnapshot.js fetches WooCommerce/Shopify
    // products in that real order now — see its own round-48 comment) —
    // never a ranking by sales/engagement, which this app has no real data
    // to honestly support (the exact goal-substitution trap this project
    // has hit before, in a new field). defaultProposed:true is carried
    // through to the stored creative specifically so formatRecommendation
    // (strategyBuilder.js) can state this rule in the text the user
    // actually reads, not just imply it.
    const count = Math.min(MAX_CAROUSEL_CARDS, candidates.length);
    chosenCandidates = candidates.slice(0, count);
    defaultProposed = true;
  } else {
    if (entries.length < MIN_CAROUSEL_CARDS || entries.length > MAX_CAROUSEL_CARDS) {
      return { ...empty, creativeError: `A carousel must have between ${MIN_CAROUSEL_CARDS} and ${MAX_CAROUSEL_CARDS} cards — got ${entries.length}.` };
    }
    const allProducts = snapshot?.business?.sampleProducts || [];
    const resolvedEntries = entries.map((e) => resolveCarouselCardEntry(e, candidates, allProducts));
    const firstError = resolvedEntries.find((r) => r.error);
    if (firstError) return { ...empty, creativeError: firstError.error };
    chosenCandidates = resolvedEntries.map((r) => r.candidate);
    const seenIds = new Set();
    for (const c of chosenCandidates) {
      if (seenIds.has(c.id)) {
        return { ...empty, creativeError: `"${c.name}" (id ${c.id}) is chosen more than once — a carousel needs ${chosenCandidates.length} DISTINCT products.` };
      }
      seenIds.add(c.id);
    }

    // Independent per-card verification — see cardIsVerifiedInMessage's
    // own header comment above for why this is scoped to CHANGED cards
    // only, never the whole resent list.
    const priorCards = (priorCreative?.source === "PRODUCT_IMAGE" && priorCreative?.layout === "CAROUSEL") ? priorCreative.cards : null;
    for (let i = 0; i < chosenCandidates.length; i++) {
      const candidate = chosenCandidates[i];
      if (priorCards?.[i]?.productId === candidate.id) continue; // unchanged — already a trusted, prior fact
      if (!cardIsVerifiedInMessage(userMessage, candidate)) {
        return {
          ...empty,
          creativeError: `Card ${i + 1} ("${candidate.name}") couldn't be independently verified against your message — refer to it by the id shown or its exact product name, and resend the complete card list.`,
        };
      }
    }
  }

  const cards = chosenCandidates.map((c) => ({ productId: c.id, imageUrl: c.imageUrl, link: c.permalink, productName: c.name, price: c.price || null }));
  return { ...empty, creative: { source: "PRODUCT_IMAGE", layout: "CAROUSEL", cards, defaultProposed } };
}

// Deterministic, backend-authored lines for the recommendation text
// (strategyBuilder.js's formatRecommendation) — same "never model prose"
// principle as formatCreativeCandidatesQuestion below: real product
// names/prices only, and the STATED rule spelled out verbatim whenever
// the default (not an explicit pick) is what's being presented, so the
// user is never asked to approve a ranking implied to be smarter than it
// actually is.
export function formatCarouselCreativeLines(creative) {
  if (!creative || creative.layout !== "CAROUSEL") return [];
  const lines = [
    creative.defaultProposed
      ? `Carousel cards (proposed — your ${creative.cards.length} most recently added products with a real image; no sales or engagement data exists yet to rank them, so recency is the rule used):`
      : `Carousel cards (${creative.cards.length}):`,
  ];
  creative.cards.forEach((c, i) => lines.push(`  ${i + 1}) ${c.productName}${c.price ? ` — ${c.price}` : ""}`));
  return lines;
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

// Same {id, label} shape stored as resolvedAssets.creativeCandidates
// (strategyBuilder.js) and consumed by matchCreativeCandidateId below —
// centralized here so the STORED refs and an in-request verification
// check (resolveCreativeSelection, further down) always derive "label"
// identically and can never drift apart.
export function toCreativeCandidateRefs(source, candidates) {
  return candidates.map((c) => ({ id: c.id, label: (source === "PRODUCT_IMAGE" ? c.name : c.captionExcerpt) || null }));
}

// Matches a user's plain-chat reply against the REAL creative candidates a
// creative-ambiguity question already showed — moved here from
// orchestrator/index.js (round 34) so the SAME strict, literal matching
// this function already did for the auto-revise pre-loop can also be used
// to independently VERIFY a content_selector the MODEL supplies directly
// as a tool parameter (see resolveCreativeSelection below) — closing the
// live bug where a model-asserted confirmedId/position was trusted with
// zero verification, unlike this function's own callers.
//
// CONFIRMED LIVE BUG (round 32): this only ever matched the full "(id
// 5814, 2050)" string the question itself rendered — the id embedded in
// prose. But the question's own closing line says "reply with the number,
// or describe which one," and the rendered list shows numbers and names,
// not raw ids. A bare "1", "1.", or the product name typed back verbatim
// all fell through to null, so the auto-revise pre-loop never fired, the
// creative question stayed open, and execute_strategy kept re-listing
// every candidate. Extended to recognize four forms, in this order — the
// first UNAMBIGUOUS match wins, same "never a guessed id" discipline as
// the Pixel auto-revise's digit-run match:
//   1. An exact real id — numeric ids (WooCommerce/Shopify product ids)
//      matched as a standalone digit run, never a substring of a larger
//      number; composite Facebook/Instagram ids ("pageId_postId") matched
//      as a literal substring, safe since that's the exact string shown.
//      2+ id matches (e.g. the message also contains an unrelated number
//      like a budget amount that coincidentally equals another
//      candidate's id) returns null rather than guessing between them.
//   2. The candidate's own displayed label as a literal, case/whitespace-
//      insensitive substring of the message (userMessageContainsText
//      above — the identical non-fuzzy discipline already used for a
//      user-supplied primaryText answer). 2+ label matches returns null.
//   3. A list-position reference to the SAME order the question was built
//      from — an explicit "N)" or "N." marker anywhere in the message
//      (the trailing-period form excludes a decimal, e.g. "2.5", via the
//      negative lookahead so a price/quantity is never misread as a
//      pick), or — only when the ENTIRE message (trimmed, minus one
//      trailing period) is just that number — a bare list number ("1").
//      A bare number is deliberately NOT matched mid-sentence: a reply
//      like "budget 600" must never be misread as picking candidate 600.
export function matchCreativeCandidateId(userMessage, candidates) {
  if (typeof userMessage !== "string" || !Array.isArray(candidates) || !candidates.length) return null;

  const digitRuns = userMessage.match(/\d+/g) || [];
  const idMatches = candidates.filter((c) => (/^\d+$/.test(c.id) ? digitRuns.includes(c.id) : userMessage.includes(c.id)));
  if (idMatches.length === 1) return idMatches[0].id;
  if (idMatches.length > 1) return null;

  const labelMatches = candidates.filter((c) => userMessageContainsText(userMessage, c.label));
  if (labelMatches.length === 1) return labelMatches[0].id;
  if (labelMatches.length > 1) return null;

  const explicitPosition = userMessage.match(/\b(\d+)(?:\)|\.(?!\d))/);
  if (explicitPosition) {
    const position = Number(explicitPosition[1]);
    if (Number.isInteger(position) && position >= 1 && position <= candidates.length) return candidates[position - 1].id;
  }

  const bareNumber = userMessage.trim().replace(/\.$/, "");
  if (/^\d+$/.test(bareNumber)) {
    const position = Number(bareNumber);
    if (Number.isInteger(position) && position >= 1 && position <= candidates.length) return candidates[position - 1].id;
  }

  return null;
}

// Round 41 fix (production deadlock, same class as round 36's
// destination_url fix): a real user routinely answers several open
// questions in one message ("yes same post and the budget will be
// 800/day and yes use the same url") — budget's USER_MESSAGE_BUDGET_PATTERN,
// creative-candidate's matchCreativeCandidateId, and destination_url's
// EMBEDDED_URL_REUSE_PATTERN (policy.js) all already tolerate this (they
// scan the whole message for their own signal), but this field's
// affirmation check required the ENTIRE message to be nothing but a bare
// word, so a compound reply never matched, the pendingCreative stayed
// open, and a follow-up "approve" — not in this pattern at all — hit the
// unresolved-question block and looped forever.
//
// Fixed the same way EMBEDDED_URL_REUSE_PATTERN layers its own matching:
// an UNAMBIGUOUS phrase that specifically names reusing "the post/
// creative" is safe to recognize ANYWHERE in the message — it has its own
// subject, so it can't plausibly be mistaken for something unrelated the
// way a bare "yes" could. The bare generic words below stay
// whole-message-only for exactly that reason: embedding those would risk
// misreading a "yes" used naturally elsewhere in a longer reply, never by
// anything other than the user's own raw words (see
// resolveCreativeSelection's pendingCreative handling — never a
// model-supplied selector merely repeating the same id, never a later
// reuse-from-prior).
//
// Accepted, documented residual risk (same as round 36's for the URL
// phrases): "use that post"/"same post" could in principle appear in a
// message that isn't actually confirming the creative. Not a new
// exposure — the identical tradeoff round 36 already made for
// EMBEDDED_URL_REUSE_PATTERN, and the alternative is the whole-message-only
// bug this round exists to fix.
const PENDING_CREATIVE_AFFIRMATION_PATTERN = /^\s*(yes|yep|yup|correct|right|confirmed?|that'?s (the )?right one|that one)[.!]?\s*$/i;
const EMBEDDED_CREATIVE_REUSE_PATTERN = /\b(use (?:the )?same (?:post|creative|image|photo|reel|video)|use that (?:post|creative|image|photo|reel|video)|same (?:post|creative|image|photo|reel|video)|that post|that creative)\b/i;
export function messageAffirmsPendingCreative(userMessage) {
  if (typeof userMessage !== "string") return false;
  return PENDING_CREATIVE_AFFIRMATION_PATTERN.test(userMessage) || EMBEDDED_CREATIVE_REUSE_PATTERN.test(userMessage);
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

// Shared tail for every path that ends with a real, trusted `chosen`
// candidate (a fresh pick that independently verified against the user's
// own words, OR an affirmed pendingCreative being promoted) — the ONLY
// place `creative` is ever constructed, so both callers get identical
// PRODUCT_IMAGE/post-based shaping.
function finalizeChosenCreative({ source, chosen, strategy, userMessage, empty }) {
  if (source === "PRODUCT_IMAGE") {
    const { primaryText, source: primaryTextSource } = resolvePrimaryText(chosen, strategy, userMessage);
    if (!primaryText) {
      return { ...empty, needsPrimaryTextQuestion: true, resolvedProductForQuestion: chosen };
    }
    return { ...empty, creative: { source, productId: chosen.id, imageUrl: chosen.imageUrl, link: chosen.permalink, productName: chosen.name, primaryText, primaryTextSource } };
  }
  return { ...empty, creative: { source, contentId: chosen.id } };
}

// strategy: the normalized, merged strategy for THIS call — genuinely
// campaign mode, OR (round 37) strategyBuilder.js's caller passing a
// SYNTHESIZED view of an explicit_action strategy (mode overridden to
// "campaign", creative_strategy.source set to EXISTING_PAGE_POST/
// EXISTING_INSTAGRAM_POST from the real action_type) so
// BOOST_FACEBOOK_POST/BOOST_INSTAGRAM_POST get the SAME candidate-list/
// pendingCreative handling as campaign mode, rather than a second,
// weaker implementation. The real, stored strategy's own mode/
// creative_strategy are never touched — only the object passed into this
// one call is synthetic. explicit_action's OTHER action types
// (USE_ATTACHED_IMAGE/USE_ATTACHED_VIDEO) still resolve via
// resolveContentSelector in strategyBuilder.js, untouched by this module
// — they reference a specific chat attachment, never ambiguous.
// priorCreative: the PRIOR strategy's resolvedAssets.creative (or null on
// a fresh build) — the "already resolved, never re-derive" reuse case.
// priorPendingCreative: the PRIOR strategy's resolvedAssets.pendingCreative
// (or null) — a pick that was NEVER independently verified against the
// user's own words, so it can only ever become `creative` through a fresh,
// explicit affirmation this call (see the pendingCreative handling below).
// It is a completely separate field from priorCreative/resolvedAssets.
// creative — nothing ever copies a pending value into the reuse-verbatim
// path above, so an unconfirmed pick can never re-enter through
// reusedFromPrior on a later call, by construction.
// contentSelectorProvidedThisCall: true when THIS call's raw (pre-merge)
// requestedChanges actually included a content_selector object — the
// signal that the user is explicitly (re-)picking creative this turn,
// exactly analogous to explicitAssetChanges for Pixel/Page/AdAccount.
//
// Live bug (round 34): a content_selector.confirmedId/position reaching
// this function was trusted identically whether it came from the
// orchestrator's auto-revise pre-loop (which independently verifies it
// against the raw current-turn message via matchCreativeCandidateId
// BEFORE ever constructing requestedChanges) or straight from the MODEL
// as a build_strategy/revise_strategy tool parameter (never verified at
// all — the model can assert any confirmedId/position it likes). A model
// guess was silently saved as `creative`, identical in effect to a real
// user answer, and then reused verbatim on every later call
// (reusedFromPrior) — the user never confirmed which of 5 real posts was
// meant. Fixed: ANY selector-driven pick (not just the auto-loop's) is
// now independently re-verified here against the SAME userMessage using
// the SAME strict matchCreativeCandidateId rules. A verified pick
// resolves exactly as before. An unverified one becomes `pendingCreative`
// instead — a real, distinct piece of question state — and can ONLY ever
// be promoted to `creative` by an explicit affirmation in a LATER raw
// userMessage (messageAffirmsPendingCreative above), never by a selector
// merely repeating the same id/position again.
export function resolveCreativeSelection({ strategy, snapshot, priorCreative, priorPendingCreative, contentSelectorProvidedThisCall, userMessage }) {
  const source = strategy.creative_strategy?.source;
  const empty = { creative: null, ambiguousCandidates: [], creativeError: null, needsPrimaryTextQuestion: false, unsupportedSource: false, pendingCreative: null };
  if (strategy.mode === "explicit_action" || !source) return empty;

  if (OUT_OF_SCOPE_SOURCES.has(source)) {
    return { ...empty, unsupportedSource: true };
  }

  // Round 48 — carousel is a PRODUCT_IMAGE-only ad FORMAT (creative_strategy.
  // layout), not a different source; resolved by its own dedicated function
  // since the shape (N cards, never one pick) is fundamentally different
  // from every branch below. Isolated in its own function (never inlined
  // here) specifically so none of the single-pick logic below — the thing
  // every existing campaign depends on — has to change to support it.
  if (source === "PRODUCT_IMAGE" && strategy.creative_strategy?.layout === "CAROUSEL") {
    return resolveCarouselSelection({ strategy, snapshot, priorCreative, contentSelectorProvidedThisCall, userMessage });
  }

  // Reuse verbatim — the prior strategy already resolved a creative for
  // the SAME source and nothing this call explicitly asked to change.
  // Never re-derived through the candidate list again (the exact bug
  // class fixed for Pixel — see this file's header comment). Only ever
  // reads resolvedAssets.creative — a pendingCreative can never reach
  // this branch, by construction (see priorPendingCreative comment above).
  if (!contentSelectorProvidedThisCall && priorCreative && priorCreative.source === source) {
    return { ...empty, creative: priorCreative };
  }

  const candidates = candidatesForSource(source, snapshot);

  // A pendingCreative from a prior call can ONLY become `creative` via an
  // explicit affirmation in THIS call's raw userMessage — never by a
  // fresh content_selector merely echoing the same id/position back (that
  // still goes through ordinary verification below, same as any other
  // pick) and never silently. A non-affirming reply leaves it pending and
  // re-surfaces the SAME confirmation question — never silently drops
  // back to re-asking the full original candidate list, and never
  // silently accepts a vague "ok"/no-reply as consent.
  if (!contentSelectorProvidedThisCall && priorPendingCreative && priorPendingCreative.source === source) {
    if (messageAffirmsPendingCreative(userMessage)) {
      return finalizeChosenCreative({ source, chosen: priorPendingCreative.candidate, strategy, userMessage, empty });
    }
    return { ...empty, pendingCreative: priorPendingCreative };
  }

  if (!candidates.length) {
    // For a genuine campaign-mode strategy, EXISTING_PAGE_POST/
    // EXISTING_INSTAGRAM_POST with zero usable content is ALREADY
    // hard-rejected, with a richer, actionable message, by
    // checkCreativeSourceAvailabilityPolicy (policy.js) — deliberately not
    // duplicated here (a second, blander rejection for the same fact would
    // just be noise). For the explicit_action synthetic case (round 37 —
    // see this function's header comment), checkCreativeSourceAvailabilityPolicy
    // never runs (it reads the REAL, un-synthesized strategy, whose
    // creative_strategy genuinely stays unset) and its advice ("switch to
    // PRODUCT_IMAGE") wouldn't make sense for a boost action anyway — the
    // caller (strategyBuilder.js) detects this exact empty-result shape
    // and raises its own, boost-appropriate message instead. Only
    // PRODUCT_IMAGE has no earlier check for this, since nothing
    // previously required a real product image to exist at all — zero
    // real candidates is a structural gap, not a question the user can
    // answer by picking, so this is a genuine rejection here.
    if (source !== "PRODUCT_IMAGE") return empty;
    return {
      ...empty,
      creativeError: "creative_strategy claims a product image as the creative, but no product in the current snapshot has a real image to use — connect/verify a product image, or choose a different creative_strategy.source.",
    };
  }

  const selector = strategy.content_selector || {};
  let chosen = null;
  let pickedViaSelector = false;
  if (typeof selector.confirmedId === "string" && selector.confirmedId) {
    chosen = candidates.find((c) => c.id === selector.confirmedId);
    if (!chosen) {
      return { ...empty, creativeError: `"${selector.confirmedId}" is not one of the real creative candidates already shown this conversation — refer to it by the id shown, or by position (the first, the second, ...).` };
    }
    pickedViaSelector = true;
  } else if (Number.isInteger(selector.position) && selector.position > 0) {
    chosen = candidates[selector.position - 1];
    if (!chosen) {
      return { ...empty, creativeError: `There is no creative candidate at position ${selector.position} — only ${candidates.length} real candidate(s) are available.` };
    }
    pickedViaSelector = true;
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    // Genuine ambiguity — 2+ real candidates, no explicit pick. Never
    // guessed, never silently defaulted to "the first one." Surfaced by
    // the caller (strategyBuilder.js) as a real unresolved_questions
    // entry naming these exact candidates.
    return { ...empty, ambiguousCandidates: candidates };
  }

  // Independent verification (round 34) — see this function's header
  // comment. Skipped only for the single-real-candidate auto-pick above
  // (candidates.length === 1, pickedViaSelector stays false), which was
  // never a guess in the first place — there was nothing else it could be.
  if (pickedViaSelector) {
    const verifiedId = matchCreativeCandidateId(userMessage, toCreativeCandidateRefs(source, candidates));
    if (verifiedId !== chosen.id) {
      return { ...empty, pendingCreative: { source, candidate: chosen } };
    }
  }

  return finalizeChosenCreative({ source, chosen, strategy, userMessage, empty });
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

// Round 34 fix — the confirmation asked when a pick couldn't be
// independently verified against the user's own words (resolveCreativeSelection's
// pendingCreative). Requirement: concrete enough that a WRONG guess is
// obvious at a glance — real caption excerpt AND real post date, same
// facts formatCreativeCandidatesQuestion already shows per-candidate, not
// just an id or a generic "this post." Deliberately ends with the exact
// same "as the ad's creative." phrase formatCreativeCandidatesQuestion's
// question ends with (just "." instead of "?") — a single shared anchor
// orchestrator/index.js's final-reply gate can check for either question
// having actually reached the customer, regardless of which one applies.
export function formatCreativeConfirmationQuestion(source, candidate) {
  const label = { EXISTING_PAGE_POST: "Facebook post", EXISTING_INSTAGRAM_POST: "Instagram post", PRODUCT_IMAGE: "product" }[source] || "item";
  if (source === "PRODUCT_IMAGE") {
    return `To confirm — you'd like to use "${candidate.name}" (id ${candidate.id}${candidate.price ? `, ${candidate.price}` : ""}) as the ad's creative. Reply "yes" to confirm, or tell me which one you actually meant.`;
  }
  const excerpt = candidate.captionExcerpt ? `"${candidate.captionExcerpt}"` : "(no caption)";
  return `To confirm — you'd like to use this ${label} as the ad's creative: ${excerpt} (posted ${candidate.publishedDate || "unknown date"}). Reply "yes" to confirm, or tell me which one you actually meant.`;
}

export function formatPrimaryTextQuestion(product) {
  return `What ad text would you like for the "${product.name}" image ad? This product has no description to pull from automatically — reply with the exact text you'd like used, and I'll use it exactly as written.`;
}
