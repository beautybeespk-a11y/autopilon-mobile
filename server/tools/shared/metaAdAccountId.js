import * as meta from "../../integrations/meta/api.js";
import { getConnection, updateConnectionMeta } from "../../integrations/manager.js";

// Unlike a Page id (server/tools/shared/metaPageId.js), a shape check alone
// is NOT enough here: both Facebook Page ids and Meta ad account ids are
// plain numeric strings, so a numeric-looking value tells you nothing about
// WHICH kind of Meta object it actually names. This still rejects anything
// that isn't shaped like an id at all (a placeholder, "act_your_ad_account_id",
// etc.) — real ad account ids are digits, optionally prefixed "act_".
const AD_ACCOUNT_ID_PATTERN = /^(act_)?\d+$/;

function normalize(id) {
  return id.startsWith("act_") ? id : `act_${id}`;
}

export function isPlausibleAdAccountId(value) {
  return typeof value === "string" && AD_ACCOUNT_ID_PATTERN.test(value);
}

// integrations.meta is a free-form per-connection JSON blob (see
// integrations/manager.js's updateConnectionMeta) — `defaults.adAccountId`
// is the one key actually read/written today. `defaults.pageId` and
// `defaults.instagramAccountId` are reserved for the same "Default Page" /
// "Default Instagram Account" feature later, following this exact pattern,
// but nothing writes or reads them yet — only building what's needed now.
function readSavedDefaultAdAccountId(conn) {
  const meta = JSON.parse(conn?.meta || "{}");
  return meta.defaults?.adAccountId || null;
}

// Resolves a real Meta ad account id for a tool call — always cross-checked
// against the user's OWN connected ad accounts (meta.listAdAccounts), never
// trusted on shape alone.
//
// Confirmed live: an agent building an ad from a Facebook Page reel reused
// that Page's own id (717559728109412 — a real, correctly-shaped numeric
// id, just the WRONG kind of Meta object) as the adAccountId for
// meta.create_campaign. A shape check (digits, optional "act_" prefix)
// cannot catch this — a Page id and an ad account id are indistinguishable
// by shape. Only checking the supplied id against the user's actual list of
// connected ad accounts can, which is why this resolver always calls
// meta.listAdAccounts, even when an id was supplied, rather than merely
// validating its format.
//
// Resolution order:
//   1. An explicit, valid, verified providedAdAccountId — always wins, even
//      over a saved default (an explicit instruction this turn overrides a
//      standing preference).
//   2. A saved Default Ad Account (userId's integrations.meta.defaults.
//      adAccountId), but ONLY after confirming it's still in the user's
//      current meta.listAdAccounts() result — access can be revoked or an
//      account removed after it was saved as default. If it's gone, the
//      stale default is cleared (best-effort; a failure to clear doesn't
//      block resolution) and resolution falls through to the next step
//      rather than using a dead id.
//   3. Exactly one connected ad account → used automatically.
//   4. Zero, or more than one with no usable default → fails with
//      META_AD_ACCOUNT_ID_REQUIRED, listing the real accounts when there's
//      a choice to make, rather than guessing.
//
// - An id supplied that isn't shaped like a real one at all → fails with
//   META_AD_ACCOUNT_ID_REQUIRED (a placeholder, not a real-vs-wrong id
//   question).
// - An id supplied (or a saved default, before it's trusted) that IS
//   shaped correctly but isn't one of this user's own connected ad
//   accounts (e.g. a Page id reused by mistake) → fails with
//   META_AD_ACCOUNT_NOT_FOUND for an explicit id — a distinct code from
//   the above, because the failure mode is different: not "missing", but
//   "verified and rejected."
export async function resolveAdAccountId({ userId, accessToken, providedAdAccountId }) {
  const accounts = await meta.listAdAccounts(accessToken);

  if (providedAdAccountId) {
    if (!isPlausibleAdAccountId(providedAdAccountId)) {
      const err = new Error(
        `"${providedAdAccountId}" is not a real Meta ad account id (must be numeric, optionally prefixed with "act_") — it looks like a placeholder. Call meta.list_ad_accounts to get the real id, don't invent one.`
      );
      err.code = "META_AD_ACCOUNT_ID_REQUIRED";
      throw err;
    }
    const normalized = normalize(providedAdAccountId);
    const match = accounts.find((a) => a.id === normalized);
    if (match) return match.id;
    const err = new Error(
      `"${providedAdAccountId}" is not one of this account's connected Meta ad accounts — it may be a different kind of Meta id (e.g. a Facebook Page id) reused by mistake. Connected ad accounts: ${
        accounts.map((a) => `${a.name} (${a.id})`).join(", ") || "(none)"
      }.`
    );
    err.code = "META_AD_ACCOUNT_NOT_FOUND";
    throw err;
  }

  if (userId) {
    const conn = getConnection(userId, "meta_ads");
    const savedDefault = readSavedDefaultAdAccountId(conn);
    if (savedDefault) {
      const stillValid = accounts.find((a) => a.id === savedDefault);
      if (stillValid) return stillValid.id;
      // The saved default no longer appears in the user's real ad accounts
      // (removed, or access revoked) — clear it so this doesn't repeat on
      // every future call, then fall through to the remaining rules below.
      // Best-effort: clearing failing shouldn't block resolving THIS call.
      try {
        updateConnectionMeta(userId, "meta_ads", { defaults: { ...JSON.parse(conn.meta || "{}").defaults, adAccountId: null } });
      } catch {
        // Non-fatal — resolution continues below regardless.
      }
    }
  }

  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    const err = new Error("No connected Meta ad accounts were found for this account.");
    err.code = "META_AD_ACCOUNT_ID_REQUIRED";
    throw err;
  }
  const err = new Error(
    `Multiple Meta ad accounts are connected and no Default Ad Account is set — a specific one must be chosen: ${accounts
      .map((a) => `${a.name} (${a.id})`)
      .join(", ")}. A default can be set in Integrations → Meta Ads to skip this next time.`
  );
  err.code = "META_AD_ACCOUNT_ID_REQUIRED";
  throw err;
}
