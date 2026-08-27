import * as meta from "../../integrations/meta/api.js";

// Facebook Page ids are always purely numeric strings — never letters,
// underscores, or punctuation. That single fact is enough to catch every
// placeholder an LLM might invent ("your_page_id", "page_id", "<page_id>",
// "PAGE_ID_HERE", "example_id", ...) without maintaining a blacklist of
// specific strings — anything that isn't all digits is not a real Page id,
// full stop.
const PAGE_ID_PATTERN = /^\d+$/;

export function isPlausibleMetaId(value) {
  return typeof value === "string" && PAGE_ID_PATTERN.test(value);
}

// Resolves a real Facebook Page id for a Meta tool call — never lets an
// LLM-invented value reach the Graph API, and never requires the caller to
// already know a real id.
//
// Confirmed live: a request for "my Facebook page's last reel" reached
// Meta with pageId literally set to the string "your_page_id", because (a)
// the tool schema had `pageId` in `required`, which meant the model had to
// supply SOMETHING to pass local parameter validation even when it didn't
// have a real id, and (b) nothing checked the value's shape before it was
// used in a Graph API URL. Meta's own error for that ("Object with ID
// 'your_page_id' does not exist...") only comes back AFTER a real network
// call — this resolver fails locally instead, before any request is made.
//
// Also confirmed live (round 3, the Meta Ads Expert planner): a
// conversation-remembered Page id can go stale (removed, access revoked)
// between when it was picked and when it's reused. This resolver now
// ALWAYS cross-checks a supplied id against a live meta.listPages() call —
// the same shape-check-is-not-enough lesson already applied to ad account
// ids in metaAdAccountId.js. A numeric-looking id that isn't actually one
// of this user's connected Pages is exactly as unsafe to trust as one that
// isn't numeric at all; both must be rejected before anything is built on
// top of them.
//
// - A supplied id that doesn't look like a real Page id (not all-digit) is
//   rejected immediately with META_PAGE_ID_REQUIRED — never sent to Meta.
// - A supplied id that IS shaped correctly but isn't one of this user's own
//   connected Pages is rejected with META_PAGE_NOT_FOUND — a distinct code,
//   because the failure mode is different: not "missing", but "verified and
//   rejected" (mirrors resolveAdAccountId's META_AD_ACCOUNT_NOT_FOUND).
// - No id supplied at all is not an error by itself: falls back to the
//   user's own connected Pages (meta.listPages) exactly like meta.list_pages
//   itself would return. Exactly one connected Page → use it, no need to
//   ask. Zero or more than one → fail with a clear, real-data-driven
//   message (the actual Page names+ids, when there's more than one) so the
//   agent can relay real options instead of guessing — never invents a
//   choice on the caller's behalf.
export async function resolvePageId({ accessToken, providedPageId }) {
  const pages = await meta.listPages(accessToken);

  if (providedPageId) {
    if (!isPlausibleMetaId(providedPageId)) {
      const err = new Error(
        `"${providedPageId}" is not a real Facebook Page id (Meta Page ids are always numeric) — it looks like a placeholder rather than a resolved id. Call meta.list_pages to get the real id, don't invent one.`
      );
      err.code = "META_PAGE_ID_REQUIRED";
      throw err;
    }
    const match = pages.find((p) => p.id === providedPageId);
    if (match) return match.id;
    const err = new Error(
      `"${providedPageId}" is not one of this account's connected Facebook Pages — it may no longer be connected, or access was removed. Connected Pages: ${
        pages.map((p) => `${p.name} (${p.id})`).join(", ") || "(none)"
      }.`
    );
    err.code = "META_PAGE_NOT_FOUND";
    throw err;
  }

  if (pages.length === 1) return pages[0].id;
  if (pages.length === 0) {
    const err = new Error("No connected Facebook Pages were found for this account.");
    err.code = "META_PAGE_ID_REQUIRED";
    throw err;
  }
  const err = new Error(
    `Multiple Facebook Pages are connected — a specific one must be chosen: ${pages.map((p) => `${p.name} (${p.id})`).join(", ")}.`
  );
  err.code = "META_PAGE_ID_REQUIRED";
  throw err;
}
