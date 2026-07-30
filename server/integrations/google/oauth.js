// Shared OAuth2 helper for all "second wave" Google integrations (Calendar,
// Drive, Docs, Sheets). Reuses the same GOOGLE_CLIENT_ID/SECRET already set
// up for Gmail — no second Google Cloud project needed. Each service still
// gets its own connection row (keyed by provider id) and its own callback
// path, derived from GOOGLE_REDIRECT_URI's origin, so you only need to add
// a few more "Authorized redirect URIs" entries to the same OAuth client —
// no new client, no new secret.

const SCOPES_BY_SERVICE = {
  google_calendar: ["https://www.googleapis.com/auth/calendar"],
  google_drive: ["https://www.googleapis.com/auth/drive"],
  google_docs: ["https://www.googleapis.com/auth/documents"],
  google_sheets: ["https://www.googleapis.com/auth/spreadsheets"],
};

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

// GOOGLE_REDIRECT_URI is set to Gmail's callback, e.g.
// https://<host>/api/integrations/gmail/callback — strip that known suffix
// to get the shared origin, then append each service's own callback path.
function baseOrigin() {
  const uri = process.env.GOOGLE_REDIRECT_URI || "";
  return uri.replace(/\/api\/integrations\/gmail\/callback\/?$/, "");
}

export function redirectUriFor(service) {
  return `${baseOrigin()}/api/integrations/${service}/callback`;
}

export function buildAuthorizationUrl(service, state) {
  const status = googleOAuthStatus();
  if (!status.configured) {
    const err = new Error(`${service} integration is not configured`);
    err.code = "GOOGLE_NOT_CONFIGURED";
    err.detail = status.reason;
    throw err;
  }
  const scopes = SCOPES_BY_SERVICE[service];
  if (!scopes) throw new Error(`Unknown Google service: ${service}`);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUriFor(service),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForToken(service, code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUriFor(service),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, scopes: SCOPES_BY_SERVICE[service] };
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
