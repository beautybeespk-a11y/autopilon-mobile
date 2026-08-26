// Standard Meta (Facebook) OAuth2 authorization-code flow for the Marketing API.
// No credentials are hardcoded — every value comes from env vars the user sets
// after creating their own Meta App at developers.facebook.com.

const API_VERSION = process.env.META_API_VERSION || "v19.0";

export function metaOAuthStatus() {
  const hasAppId = Boolean(process.env.META_APP_ID);
  const hasSecret = Boolean(process.env.META_APP_SECRET);
  const hasRedirect = Boolean(process.env.META_REDIRECT_URI);
  const configured = hasAppId && hasSecret && hasRedirect;
  return {
    configured,
    reason: configured
      ? null
      : `Missing: ${[!hasAppId && "META_APP_ID", !hasSecret && "META_APP_SECRET", !hasRedirect && "META_REDIRECT_URI"].filter(Boolean).join(", ")}`,
  };
}

// pages_show_list added for meta.list_pages (needed to pick the page an
// ad's creative posts as — ads_management alone doesn't expose /me/accounts).
// Anyone already connected before this needs to reconnect to grant it; a
// token issued under the old scope list doesn't retroactively gain it.
const SCOPES = ["ads_read", "ads_management", "pages_show_list"];

export function buildAuthorizationUrl(state) {
  const status = metaOAuthStatus();
  if (!status.configured) {
    const err = new Error("Meta integration is not configured");
    err.code = "META_NOT_CONFIGURED";
    err.detail = status.reason;
    throw err;
  }
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    state,
    scope: SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/${API_VERSION}/dialog/oauth?${params.toString()}`;
}

export async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: process.env.META_REDIRECT_URI,
    code,
  });
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`Meta token exchange failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  // Meta's short-lived user tokens can be exchanged for a long-lived one —
  // do that immediately so the connection doesn't expire in ~1-2 hours.
  return exchangeForLongLivedToken(data.access_token);
}

async function exchangeForLongLivedToken(shortLivedToken) {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });
  const res = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?${params.toString()}`);
  if (!res.ok) throw new Error(`Meta long-lived token exchange failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null;
  return { accessToken: data.access_token, expiresAt, scopes: SCOPES };
}

// Phase 18.2 §2/§3 — Meta SUPPORTS real revocation via DELETE /me/permissions,
// which de-authorizes this app for the user (revokes the whole grant, not
// just one token — Meta has no separate access/refresh-token pair to
// revoke individually the way Google does). Sent as an Authorization:
// Bearer header rather than the ?access_token= query param the rest of
// this app's Meta client (integrations/meta/api.js) uses — deliberately,
// same reasoning as the Phase 18.1 WooCommerce fix: Graph API documents
// both forms as equivalent, and a header keeps the token out of any
// access/proxy log this specific call might pass through. Not a
// retrofit of every existing Meta API call (out of this phase's scope,
// see PHASE18_2_NOTES.md) — just how this new code is written.
// Phase 18.2 §16 — bounded wait, same reasoning as gmail/oauth.js's
// revokeToken(): this new revoke call gets a timeout even though the
// rest of this app's fetch() calls (pre-existing, out of this phase's
// scope) don't.
const REVOKE_TIMEOUT_MS = 10_000;

export async function revokeToken(accessToken) {
  if (!accessToken) return { revoked: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://graph.facebook.com/${API_VERSION}/me/permissions`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch (err) {
    const wrapped = new Error(err.name === "AbortError" ? "Meta token revocation timed out" : `Meta token revocation failed: ${err.message}`);
    wrapped.code = err.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const err = new Error(data?.error?.message || `Meta token revocation failed (${res.status})`);
    err.code = data?.error?.code || res.status;
    throw err;
  }
  return { revoked: true };
}
