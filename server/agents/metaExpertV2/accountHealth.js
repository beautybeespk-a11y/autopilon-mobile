// Account health check — Phase 1 of the Meta Ads V2 roadmap.
//
// The lesson from Nov 6 2026: the ad account was disabled for a past-due
// payment and nobody knew for days while code fixes were chased, because
// the agent built the whole campaign first and only failed at the very
// last Meta write, with a cryptic error (200/1487194). This module checks
// the account is actually healthy BEFORE the agent builds or executes
// anything, and stops early with a plain-language warning when it is not.
//
// What it checks (all read-only — nothing here creates, changes or spends
// anything):
//   1. Ad account status — active (1) vs disabled (2, usually past-due
//      billing) vs unsettled balance (3) vs anything else.
//   2. Token scopes — every scope the app requests (oauth.js SCOPES) is
//      actually granted on this token. A scope revoked in Business
//      Settings, or a token issued before a scope was added, shows up
//      here instead of as a cryptic (#200) at execute time.
//   3. Facebook Page linked — a Page access token can still be obtained
//      for the resolved Page. A Page unlinked since the strategy was
//      built is caught here, not at creative creation.
//   4. Pixel resolvable — the resolved Pixel still exists on the ad
//      account. No Pixel resolved yet is NOT a problem (the existing
//      no-Pixel question flow handles that); only a Pixel that has
//      vanished is.
//
// Failure policy — deliberately asymmetric:
//   * A check that PROVES a problem blocks the build/execute with a
//     plain-language issue (the owner can act on it).
//   * A Meta/network error on a check FAILS OPEN (logged, build proceeds)
//     — a transient outage must not block a healthy account, and the
//     build's own asset resolution will surface the real error if the
//     account is genuinely unreachable. The ONE exception is an auth
//     error (Meta 190/102: the token itself is dead or expired) — every
//     later Meta call would fail with the same cryptic error, so it
//     blocks with "reconnect your Meta account".
//   * The Pixel list check fails open on ANY error — a listPixels failure
//     is not proof the Pixel is gone.
//
// Caching: healthy results are cached 5 minutes, unhealthy 60 seconds,
// keyed by user + ad account + page + pixel, so a healthy account costs
// zero extra Meta calls on most turns while a fixed account is re-checked
// quickly. The cache is module-level and in-memory only; clear it in
// tests with clearAccountHealthCache().
import { getAdAccount, getPageAccessToken, listPixels, listPermissions } from "../../integrations/meta/api.js";
import { SCOPES } from "../../integrations/meta/oauth.js";
import { logger } from "../../config/logger.js";

const HEALTHY_TTL_MS = 5 * 60 * 1000;
const UNHEALTHY_TTL_MS = 60 * 1000;

const cache = new Map();

export function clearAccountHealthCache() {
  cache.clear();
}

// Meta's auth errors (api.js throws with err.code = Meta's numeric code):
// 190 = invalid/expired OAuth token, 102 = session expired. Either one
// means the token itself is dead — every later Meta call fails the same
// way, so the health check blocks instead of failing open.
function isAuthError(err) {
  return err?.code === 190 || err?.code === 102;
}

function authIssue() {
  return {
    field: "meta_connection",
    code: "META_V2_ACCOUNT_AUTH",
    message: "Your Meta connection isn't working right now — the token was rejected. Reconnect your Meta account and try again.",
  };
}

export async function checkAccountHealth({ accessToken, adAccountId, pageId, pixelId }) {
  const issues = [];

  // 1 — Ad account status. account_status: 1 active, 2 disabled, 3
  // unsettled. (Nov 6 2026: the account was 2 — disabled for a past-due
  // payment — and the agent kept building campaigns against it.)
  try {
    const account = await getAdAccount(accessToken, adAccountId);
    const status = Number(account?.account_status);
    if (status === 2) {
      issues.push({ field: "ad_account", code: "META_V2_ACCOUNT_DISABLED", message: "Your ad account is disabled — this is usually a past-due payment. Settle it in Meta Business Settings (billing) first, then try again." });
    } else if (status === 3) {
      issues.push({ field: "ad_account", code: "META_V2_ACCOUNT_UNSETTLED", message: "Your ad account has an unsettled balance. Settle it in Meta Business Settings (billing) first, then try again." });
    } else if (status !== 1) {
      issues.push({ field: "ad_account", code: "META_V2_ACCOUNT_INACTIVE", message: `Your ad account is not active right now (status ${account?.account_status ?? "unknown"}). Check it in Meta Business Settings before trying again.` });
    }
  } catch (err) {
    if (isAuthError(err)) issues.push(authIssue());
    else logger.warn("meta_expert_v2.account_health.account_check_open", { adAccountId, error: String(err?.message || err) });
  }

  // 2 — Token scopes. A scope that was never granted (token issued before
  // the app requested it, e.g. pages_manage_ads before Nov 6) or revoked
  // in Business Settings simply isn't in the granted set.
  try {
    const perms = await listPermissions(accessToken);
    const granted = new Set((perms?.data || []).filter((p) => p.status === "granted").map((p) => p.permission));
    const missing = SCOPES.filter((s) => !granted.has(s));
    if (missing.length) {
      issues.push({
        field: "token_scopes",
        code: "META_V2_SCOPES_MISSING",
        message: `Your Meta connection is missing ${missing.length === 1 ? "a permission" : "permissions"} it needs: ${missing.join(", ")}. Reconnect your Meta account and approve all permissions, then try again.`,
      });
    }
  } catch (err) {
    if (isAuthError(err)) issues.push(authIssue());
    else logger.warn("meta_expert_v2.account_health.scopes_check_open", { adAccountId, error: String(err?.message || err) });
  }

  // 3 — Page linked. getPageAccessToken throws the named
  // META_PAGE_TOKEN_UNAVAILABLE when the Page can't be reached via the
  // token or any connected Business Portfolio — that is the proof the
  // Page is unlinked, so it blocks.
  if (pageId) {
    try {
      await getPageAccessToken(accessToken, pageId);
    } catch (err) {
      if (err?.code === "META_PAGE_TOKEN_UNAVAILABLE") {
        issues.push({ field: "page", code: "META_V2_PAGE_UNLINKED", message: `Your Facebook Page (${pageId}) isn't linked to this Meta connection any more — its Page access token couldn't be obtained. Reconnect your Meta account (or re-link the Page in Business Settings) and try again.` });
      } else if (isAuthError(err)) issues.push(authIssue());
      else logger.warn("meta_expert_v2.account_health.page_check_open", { adAccountId, pageId, error: String(err?.message || err) });
    }
  }

  // 4 — Pixel resolvable. Only when a Pixel is actually resolved for this
  // strategy; no Pixel yet is handled by the existing no-Pixel question
  // flow and is not a health problem. Fails open on ANY error.
  if (pixelId) {
    try {
      const pixels = await listPixels(accessToken, adAccountId);
      if (Array.isArray(pixels) && !pixels.some((p) => String(p.id) === String(pixelId))) {
        issues.push({ field: "pixel", code: "META_V2_PIXEL_NOT_FOUND", message: `The Pixel this strategy uses (${pixelId}) couldn't be found on your ad account any more. Check it in Meta Events Manager, then rebuild the strategy.` });
      }
    } catch (err) {
      logger.warn("meta_expert_v2.account_health.pixel_check_open", { adAccountId, pixelId, error: String(err?.message || err) });
    }
  }

  return { ok: issues.length === 0, issues };
}

// Cached wrapper — the one the build/execute hooks call. Keyed on
// user + account + page + pixel: a different Page or Pixel on the same
// account is a different check, never a stale reuse.
export async function checkAccountHealthCached({ userId, accessToken, adAccountId, pageId, pixelId }) {
  const key = `${userId}:${adAccountId}:${pageId || ""}:${pixelId || ""}`;
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && now - entry.at < (entry.result.ok ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS)) {
    return entry.result;
  }
  const result = await checkAccountHealth({ accessToken, adAccountId, pageId, pixelId });
  cache.set(key, { at: now, result });
  return result;
}
