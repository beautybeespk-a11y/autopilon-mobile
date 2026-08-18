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
// Phase 18.2 §16 — no fetch() anywhere in this app's integrations layer
// has ever had a timeout (a pre-existing, systemic gap out of this
// phase's scope to retrofit everywhere), but this revoke call is new
// code this phase is directly responsible for hardening, and "provider
// times out" is explicitly in the failure-handling checklist — so this
// one gets a bounded wait rather than being able to hang a disconnect
// request indefinitely if Google's revoke endpoint never responds.
const REVOKE_TIMEOUT_MS = 10_000;

export async function revokeToken(token) {
  if (!token) return { revoked: false, alreadyInvalid: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: controller.signal,
    });
  } catch (err) {
    const wrapped = new Error(err.name === "AbortError" ? "Google token revocation timed out" : `Google token revocation failed: ${err.message}`);
    wrapped.code = err.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return { revoked: true, alreadyInvalid: false };
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body, fall through to the generic error below */ }
  if (res.status === 400 && data?.error === "invalid_token") return { revoked: true, alreadyInvalid: true };
  const err = new Error(`Google token revocation failed (${res.status})`);
  err.code = res.status;
  throw err;
}
