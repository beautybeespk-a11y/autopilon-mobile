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
