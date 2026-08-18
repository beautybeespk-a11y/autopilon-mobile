// Standard Google OAuth2 authorization-code flow. Unlike Meta, Google issues
// a real long-lived refresh_token, so once connected this doesn't need
// periodic re-authorization the way Meta Ads' user tokens eventually do.

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export function googleOAuthStatus() {
  const hasClientId = Boolean(process.env.GOOGLE_CLIENT_ID);
  const hasSecret = Boolean(process.env.GOOGLE_CLIENT_SECRET);
  const hasRedirect = Boolean(process.env.GOOGLE_REDIRECT_URI);
  const configured = hasClientId && hasSecret && hasRedirect;
  return {
    configured,
    reason: configured
      ? null
      : `Missing: ${[!hasClientId && "GOOGLE_CLIENT_ID", !hasSecret && "GOOGLE_CLIENT_SECRET", !hasRedirect && "GOOGLE_REDIRECT_URI"].filter(Boolean).join(", ")}`,
  };
}

export function buildAuthorizationUrl(state) {
  const status = googleOAuthStatus();
  if (!status.configured) {
    const err = new Error("Gmail integration is not configured");
    err.code = "GOOGLE_NOT_CONFIGURED";
    err.detail = status.reason;
    throw err;
  }
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent",      // forces a fresh refresh_token even on repeat connects
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForToken(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, scopes: SCOPES };
}

export async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return { accessToken: data.access_token, expiresAt };
}

// Phase 18.2 §2/§3 — Google SUPPORTS real token revocation: POST to this
// endpoint with either the refresh_token or access_token as the `token`
// param. Revoking the refresh_token also invalidates every access_token
// derived from it and revokes the app's whole grant — always prefer it
// over the (narrower) access token when both are available, since that's
// the closer match to "disconnect this integration" than "invalidate one
// short-lived token." A 400 with error=invalid_token means Google already
// considers the token dead (already revoked, expired, or simply unknown to
// them) — that's not a failure to report, it's the end state disconnect
// was trying to reach anyway, so it's treated as success rather than an
// error the caller needs to handle specially.
export async function revokeToken(token) {
  if (!token) return { revoked: false, alreadyInvalid: false };
  const res = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (res.ok) return { revoked: true, alreadyInvalid: false };
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body, fall through to the generic error below */ }
  if (res.status === 400 && data?.error === "invalid_token") return { revoked: true, alreadyInvalid: true };
  const err = new Error(`Google token revocation failed (${res.status})`);
  err.code = res.status;
  throw err;
}
