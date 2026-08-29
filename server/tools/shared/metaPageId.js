import * as meta from "../../integrations/meta/api.js";
import { getConnection, updateConnectionMeta } from "../../integrations/manager.js";

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

// Same shape as metaAdAccountId.js's readSavedDefaultAdAccountId — a
// Default Facebook Page, saved under the SAME integrations.meta.defaults
// blob (routes/metaAuth.js's setDefault() already spreads the existing
// `defaults` object rather than replacing it, specifically so adAccountId
// and pageId can coexist there without either overwriting the other).
function readSavedDefaultPageId(conn) {
  const meta = JSON.parse(conn?.meta || "{}");
  return meta.defaults?.pageId || null;
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
// - No id supplied at all is not an error by itself. Resolution order
//   (mirrors resolveAdAccountId exactly — confirmed live, round 5: with no
//   default set, every fresh conversation forced the model to re-guess
//   among multiple real Pages, and it guessed wrong at least once,
//   producing the exact "used Careonabudget.pk instead of Beautybeespk"
//   live bug):
//     1. An explicit, valid, verified providedPageId — always wins.
//     2. A saved Default Facebook Page (userId's integrations.meta.
//        defaults.pageId), but ONLY after confirming it's still in
//        meta.listPages() — self-heals (clears) the same way a stale
//        Default Ad Account does if it's gone.
//     3. Exactly one connected Page → used automatically.
//     4. Zero, or more than one with no usable default → fails with
//        META_PAGE_ID_REQUIRED, listing the real Pages when there's a
//        choice to make.
// `userId` is optional — omitted, this behaves exactly as before (no
// default lookup), so every existing caller that doesn't pass it keeps
// working unchanged.
export async function resolvePageId({ accessToken, providedPageId, userId }) {
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

  if (userId) {
    const conn = getConnection(userId, "meta_ads");
    const savedDefault = readSavedDefaultPageId(conn);
    if (savedDefault) {
      const stillValid = pages.find((p) => p.id === savedDefault);
      if (stillValid) return stillValid.id;
      try {
        updateConnectionMeta(userId, "meta_ads", { defaults: { ...JSON.parse(conn.meta || "{}").defaults, pageId: null } });
      } catch {
        // Non-fatal — resolution continues below regardless.
      }
    }
  }

  if (pages.length === 1) return pages[0].id;
  if (pages.length === 0) {
    const err = new Error("No connected Facebook Pages were found for this account.");
    err.code = "META_PAGE_ID_REQUIRED";
    throw err;
  }
  const err = new Error(
    `Multiple Facebook Pages are connected and no Default Page is set — a specific one must be chosen: ${pages
      .map((p) => `${p.name} (${p.id})`)
      .join(", ")}. A default can be set in Integrations → Meta Ads to skip this next time.`
  );
  err.code = "META_PAGE_ID_REQUIRED";
  throw err;
}
