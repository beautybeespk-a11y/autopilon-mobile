import * as meta from "../../integrations/meta/api.js";

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
// - No id supplied: exactly one connected ad account → used automatically;
//   zero, or more than one with none specified → fails with
//   META_AD_ACCOUNT_ID_REQUIRED, listing the real accounts when there's a
//   choice to make, rather than guessing.
// - An id supplied that isn't shaped like a real one at all → fails with
//   META_AD_ACCOUNT_ID_REQUIRED (a placeholder, not a real-vs-wrong id
//   question).
// - An id supplied that IS shaped correctly but isn't one of this user's
//   own connected ad accounts (e.g. a Page id reused by mistake) → fails
//   with META_AD_ACCOUNT_NOT_FOUND — a distinct code from the above,
//   because the failure mode is different: not "missing", but "verified
//   and rejected."
export async function resolveAdAccountId({ accessToken, providedAdAccountId }) {
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

  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    const err = new Error("No connected Meta ad accounts were found for this account.");
    err.code = "META_AD_ACCOUNT_ID_REQUIRED";
    throw err;
  }
  const err = new Error(
    `Multiple Meta ad accounts are connected — a specific one must be chosen: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}.`
  );
  err.code = "META_AD_ACCOUNT_ID_REQUIRED";
  throw err;
}
