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

const SCOPES = ["ads_read", "ads_management"];

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
