#!/usr/bin/env node
// Read-only diagnostic for a user's stored Meta Ads token — reports what
// Meta's OWN endpoints say about it, rather than trusting this app's
// `integrations.scopes` column (which only ever stores the scopes
// REQUESTED at OAuth time, never verifies what Meta actually granted — see
// oauth.js's exchangeForLongLivedToken and the Meta Ads integration audit
// this same session).
//
// Every check this script makes is a GET against a read-only Meta
// endpoint: /debug_token, /me/permissions, /act_.../ (fields=id,name,
// account_status), /act_.../campaigns. Nothing here writes to the
// database, changes any OAuth setting, or refreshes/replaces/revokes the
// token — it reuses this app's own getConnection() to load and decrypt
// the already-stored token exactly as every real tool call does, then
// only reads. Never logs the access token or the Meta App Secret; only
// what Meta's API reports about them.
//
// Usage:
//   node scripts/debugMetaToken.js <userId-or-email> [adAccountId]
// adAccountId defaults to 237956315579168 (with or without "act_") if
// omitted.
//
// Requires META_APP_ID / META_APP_SECRET already set in the environment
// (the same ones the running app uses) — debug_token is authenticated
// with an app token (`{app-id}|{app-secret}`), not a user token, which is
// why this needs the app secret available to run at all. The app secret
// itself is only ever used inline in one request URL, never logged.
import db from "../db.js";
import { getConnection } from "../integrations/manager.js";

const API_VERSION = process.env.META_API_VERSION || "v19.0";
const REQUIRED_SCOPES = ["ads_read", "ads_management", "business_management", "pages_show_list", "pages_read_engagement"];
const DEFAULT_AD_ACCOUNT_ID = "237956315579168";

function resolveUserId(idOrEmail) {
  if (!idOrEmail.includes("@")) return idOrEmail;
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(idOrEmail);
  if (!row) throw new Error(`No user found with email "${idOrEmail}".`);
  return row.id;
}

function normalizeAdAccountId(id) {
  return id.startsWith("act_") ? id : `act_${id}`;
}

// Every fetch in this script goes through here so an error is always
// reported in full (message, type, code, error_subcode, fbtrace_id — the
// complete Meta error object) instead of a caller having to remember to
// check `json.error` itself. The URL is built and used but NEVER logged —
// every one of these URLs carries either the user token or the app
// secret in a query param.
async function metaGet(label, url) {
  let json;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch (err) {
    return { label, ok: false, networkError: err.message };
  }
  if (json.error) {
    return { label, ok: false, error: json.error };
  }
  return { label, ok: true, data: json };
}

async function main() {
  const [arg, adAccountArg] = process.argv.slice(2);
  if (!arg) {
    console.error("Usage: node scripts/debugMetaToken.js <userId-or-email> [adAccountId]");
    process.exit(1);
  }
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    console.error("META_APP_ID / META_APP_SECRET are not set in this environment — cannot authenticate the debug_token call.");
    process.exit(1);
  }

  const userId = resolveUserId(arg);
  const conn = getConnection(userId, "meta_ads");
  if (!conn || !conn.accessToken) {
    console.error(`No connected meta_ads integration found for user "${arg}".`);
    process.exit(1);
  }
  const adAccountId = normalizeAdAccountId(adAccountArg || DEFAULT_AD_ACCOUNT_ID);

  const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;

  const debugUrl = new URL(`https://graph.facebook.com/${API_VERSION}/debug_token`);
  debugUrl.searchParams.set("input_token", conn.accessToken);
  debugUrl.searchParams.set("access_token", appToken);

  const permsUrl = new URL(`https://graph.facebook.com/${API_VERSION}/me/permissions`);
  permsUrl.searchParams.set("access_token", conn.accessToken);

  const accountUrl = new URL(`https://graph.facebook.com/${API_VERSION}/${adAccountId}`);
  accountUrl.searchParams.set("fields", "id,name,account_status");
  accountUrl.searchParams.set("access_token", conn.accessToken);

  const campaignsUrl = new URL(`https://graph.facebook.com/${API_VERSION}/${adAccountId}/campaigns`);
  campaignsUrl.searchParams.set("fields", "id,name,status");
  campaignsUrl.searchParams.set("limit", "5");
  campaignsUrl.searchParams.set("access_token", conn.accessToken);

  const [debugResult, permsResult, accountResult, campaignsResult] = await Promise.all([
    metaGet("debug_token", debugUrl),
    metaGet("me/permissions", permsUrl),
    metaGet("ad account lookup", accountUrl),
    metaGet("campaigns lookup", campaignsUrl),
  ]);

  const printError = (result) => {
    if (result.networkError) {
      console.log(`   REQUEST FAILED (network): ${result.networkError}`);
      return;
    }
    const e = result.error;
    console.log(`   FAILED — message: ${e.message}`);
    console.log(`            type: ${e.type || "(none)"} | code: ${e.code ?? "(none)"} | error_subcode: ${e.error_subcode ?? "(none)"} | fbtrace_id: ${e.fbtrace_id || "(none)"}`);
  };

  console.log("=== Meta Token Diagnostic — read-only, token and app secret never printed ===\n");

  // --- 1-5: debug_token ---
  console.log("--- /debug_token ---");
  if (!debugResult.ok) {
    printError(debugResult);
  } else {
    const info = debugResult.data.data || {};
    console.log("Token valid:", info.is_valid === true ? "yes" : "no");
    console.log("Facebook user ID on token:", info.user_id || "(not returned)");
    console.log("App ID on token:", info.app_id || "(not returned)");
    console.log("Configured META_APP_ID:", process.env.META_APP_ID);
    console.log("App ID matches META_APP_ID:", String(info.app_id) === String(process.env.META_APP_ID) ? "yes" : "NO — MISMATCH");
    console.log(
      "Expiration date:",
      info.expires_at === 0
        ? "never expires (long-lived, no set expiry)"
        : info.expires_at
        ? new Date(info.expires_at * 1000).toISOString()
        : "(not returned)"
    );
    console.log("Actual granted scopes (from Meta):", (info.scopes || []).join(", ") || "(none returned)");
  }

  // --- 6: /me/permissions + required-scope status ---
  console.log("\n--- /me/permissions ---");
  let permsList = [];
  if (!permsResult.ok) {
    printError(permsResult);
  } else {
    permsList = permsResult.data.data || [];
    const statusByPermission = new Map(permsList.map((p) => [p.permission, p.status]));
    const debugScopes = new Set((debugResult.ok ? debugResult.data.data?.scopes : []) || []);
    console.log("Status of required scopes:");
    for (const scope of REQUIRED_SCOPES) {
      const status = statusByPermission.get(scope) || (debugScopes.has(scope) ? "granted" : "not requested / not present");
      console.log(`   ${scope.padEnd(24)} ${status}`);
    }
    const declined = permsList.filter((p) => p.status === "declined").map((p) => p.permission);
    const expiredPerms = permsList.filter((p) => p.status === "expired").map((p) => p.permission);
    console.log("Declined permissions:", declined.length ? declined.join(", ") : "(none)");
    console.log("Expired permissions:", expiredPerms.length ? expiredPerms.join(", ") : "(none)");
  }

  // --- ad account lookup ---
  console.log(`\n--- Ad account lookup: GET /${adAccountId}?fields=id,name,account_status ---`);
  if (!accountResult.ok) {
    printError(accountResult);
  } else {
    console.log("Result:", JSON.stringify(accountResult.data));
  }

  // --- campaigns lookup ---
  console.log(`\n--- Campaigns lookup: GET /${adAccountId}/campaigns?fields=id,name,status&limit=5 ---`);
  if (!campaignsResult.ok) {
    printError(campaignsResult);
  } else {
    console.log("Result:", JSON.stringify(campaignsResult.data));
  }

  console.log("\n--- For reference: this app's stored `scopes` column (REQUESTED at OAuth time, not a verified grant) ---");
  console.log(JSON.stringify(JSON.parse(db.prepare("SELECT scopes FROM integrations WHERE userId = ? AND provider = 'meta_ads' AND orgId IS NULL").get(userId)?.scopes || "[]")));
}

main().catch((err) => {
  console.error("Diagnostic failed:", err.message);
  process.exit(1);
});
