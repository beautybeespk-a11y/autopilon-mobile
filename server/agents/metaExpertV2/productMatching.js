// Meta Ads Expert V2 — token/keyword product matching.
//
// Live bug (Nov 6 2026, Test 1): every product-name check in V2 required
// the EXACT full WooCommerce name to appear word-for-word — in the user's
// message (deriveRequestedProductFromMessage), in a caption
// (matchLinkedProduct / postMatchesProduct), and in the build-time parse
// (parseRequestedProduct). The store's real product is
// "Maybelline Moisturizing Serum Lipstick Matte", but the user typed
// "Maybelline Serum Matte Lipstick" and the post's caption says the same
// short phrase — "Moisturizing" missing, "Matte" in a different place —
// so all three checks returned null/no-match, the deep product search
// never ran, and the agent fell back to listing the 5 newest posts.
// The regression test passed anyway because it mocked the catalogue name
// as the short phrase, so user words, catalogue name and caption all
// agreed word-for-word — a case that never happens in real life.
//
// This module is the ONE matching rule, shared by all three layers
// (businessSnapshot.js, creativeResolution.js, and everything that calls
// postMatchesProduct — policy.js, executor.js, strategyBuilder.js).
// Never duplicate the rule again: a fix here fixes every layer, and a
// drift here is exactly how the Nov 6 bug happened (three copies of the
// same exact-substring rule, all wrong the same way).
//
// Rule — token overlap, not substring:
//   * Normalise: lowercase, strip accents (crème -> creme), split on any
//     non-alphanumeric character, drop glue words (an/the/and/of/for/...
//     — length > 1 only, so a meaningful one-letter token such as the "C"
//     in "Vitamin C Serum" or the "A" in "Product A" is never dropped).
//   * A catalogue name matches a text iff the text contains enough of the
//     name's distinctive tokens: ALL of them when the name has 3 or
//     fewer tokens, otherwise all but one (and never fewer than 3).
//     "All but one" is deliberate: it tolerates exactly the real-world
//     differences — one filler word added ("Moisturizing") or one word
//     dropped/reordered — while still refusing a different product from
//     the same brand ("Maybelline SuperStay Matte Lipstick" shares only
//     3 of the 5 tokens of "Maybelline Moisturizing Serum Lipstick
//     Matte", so it does NOT match). A bare price (1250), a single word
//     ("Maybelline", "lipstick"), or a brand + one word can never match
//     a multi-token name: the floor is 3 matched tokens.
//   * When several catalogue products qualify, the best match wins:
//     most matched tokens, then highest matched ratio, then longest
//     name (so a specific product beats a generic shorter one, e.g.
//     "Maybelline Serum Matte Lipstick" beats a hypothetical plain
//     "Lipstick"), then catalogue order. Deterministic, never a guess
//     between equal scores — ties fall through to the longest name,
//     then first in the list.
//
// What this is NOT: it is not semantic/fuzzy matching and never invents
// a product. A text that matches no real catalogue product still yields
// null / false, exactly as before — the only change is that "the same
// product, worded slightly differently" now counts as a match.

const FILLER_TOKENS = new Set([
  "an", "the", "and", "or", "of", "for", "with", "by", "in", "on", "to",
  "from", "per", "each", "at", "is", "are", "as", "it", "its",
]);

export function normalizeProductText(text) {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeProductText(text) {
  const normalized = normalizeProductText(text);
  return normalized ? normalized.split(" ") : [];
}

// The tokens that actually identify a product: its name's tokens minus
// glue words. Single-character tokens are kept — they can be the whole
// identity ("Vitamin C Serum", "Product A").
export function distinctiveTokens(name) {
  const seen = new Set();
  const out = [];
  for (const token of tokenizeProductText(name)) {
    if (token.length > 1 && FILLER_TOKENS.has(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

// How many tokens of `productName` a text must contain to count as a
// match. Short names must match in full (a 1- or 2-token name has
// nothing to spare); longer names may miss exactly one token.
export function requiredTokenMatches(wantedTokens) {
  if (wantedTokens.length <= 3) return wantedTokens.length;
  return Math.max(3, wantedTokens.length - 1);
}

export function scoreProductNameAgainstText(productName, text) {
  const wanted = distinctiveTokens(productName);
  const haystack = new Set(tokenizeProductText(text));
  const matchedTokens = wanted.filter((t) => haystack.has(t));
  const required = requiredTokenMatches(wanted);
  return {
    wantedTokens: wanted,
    matchedTokens,
    matchedCount: matchedTokens.length,
    wantedCount: wanted.length,
    required,
    passes: wanted.length > 0 && matchedTokens.length >= required,
  };
}

// Does `text` (a user message or a post caption) mention the product
// named by `productName` (a real catalogue name)? Token-overlap rule
// above — never a plain substring, never a guess.
export function productNameMatchesText(productName, text) {
  if (typeof productName !== "string" || !productName.trim()) return false;
  if (typeof text !== "string" || !text.trim()) return false;
  return scoreProductNameAgainstText(productName, text).passes;
}

// Score every catalogue product against a text, best first —
// including products that do NOT pass, so a miss can be diagnosed from
// the scores alone (the closest near-miss and how far short it fell).
// Used by the snapshot trace.
export function scoreAllProductsAgainstText(text, sampleProducts) {
  if (typeof text !== "string" || !Array.isArray(sampleProducts)) return [];
  return sampleProducts
    .filter((p) => p && typeof p.name === "string" && p.name.trim())
    .map((product) => ({ product, score: scoreProductNameAgainstText(product.name, text) }))
    .sort((a, b) => {
      if (b.score.matchedCount !== a.score.matchedCount) return b.score.matchedCount - a.score.matchedCount;
      const ratioA = a.score.matchedCount / Math.max(1, a.score.wantedCount);
      const ratioB = b.score.matchedCount / Math.max(1, b.score.wantedCount);
      if (ratioB !== ratioA) return ratioB - ratioA;
      return b.product.name.length - a.product.name.length;
    });
}

// Only the products that actually qualify, best first. Used by
// findBestProductMatch.
export function scoreProductsAgainstText(text, sampleProducts) {
  return scoreAllProductsAgainstText(text, sampleProducts).filter((entry) => entry.score.passes);
}

// The single best-matching real catalogue product for a text, or null
// when nothing qualifies. Never guesses: no qualifying product means
// "no product named", not the closest product.
export function findBestProductMatch(text, sampleProducts) {
  const scored = scoreProductsAgainstText(text, sampleProducts);
  return scored.length ? scored[0].product : null;
}
