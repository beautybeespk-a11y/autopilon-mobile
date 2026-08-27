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
// - A supplied id that doesn't look like a real Page id (not all-digit) is
//   rejected immediately — never sent to Meta.
// - No id supplied at all is not an error by itself: falls back to the
//   user's own connected Pages (meta.listPages) exactly like meta.list_pages
//   itself would return. Exactly one connected Page → use it, no need to
//   ask. Zero or more than one → fail with a clear, real-data-driven
//   message (the actual Page names+ids, when there's more than one) so the
//   agent can relay real options instead of guessing — never invents a
//   choice on the caller's behalf.
//
// Every failure here carries `.code = "META_PAGE_ID_REQUIRED"` so callers
// (and the agent) can tell "you need to supply/resolve a Page id" apart
// from any other kind of failure.
export async function resolvePageId({ accessToken, providedPageId }) {
  if (providedPageId) {
    if (isPlausibleMetaId(providedPageId)) return providedPageId;
    const err = new Error(
      `"${providedPageId}" is not a real Facebook Page id (Meta Page ids are always numeric) — it looks like a placeholder rather than a resolved id. Call meta.list_pages to get the real id, don't invent one.`
    );
    err.code = "META_PAGE_ID_REQUIRED";
    throw err;
  }

  const pages = await meta.listPages(accessToken);
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
