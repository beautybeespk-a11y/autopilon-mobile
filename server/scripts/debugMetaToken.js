#!/usr/bin/env node
// Read-only diagnostic for a user's stored Meta Ads token — reports what
// Meta's OWN debug_token and /me/permissions endpoints say about it, rather
// than trusting this app's `integrations.scopes` column (which only ever
// stores the scopes REQUESTED at OAuth time, never verifies what Meta
// actually granted — see the Meta Ads integration audit this same
// session). Makes no writes: not to the database, not to Meta, not to the
// OAuth flow. Never prints the access token itself, only what Meta's API
// says about it.
//
// Usage:
//   node scripts/debugMetaToken.js <userId-or-email>
//
// Requires META_APP_ID / META_APP_SECRET to already be set in the
// environment (the same ones the running app uses) — debug_token is
// authenticated with an app token (`{app-id}|{app-secret}`), not a user
// token, which is why this needs the app secret available to run at all.
import db from "../db.js";
import { getConnection } from "../integrations/manager.js";

const API_VERSION = process.env.META_API_VERSION || "v19.0";
const REQUIRED_SCOPES = ["ads_read", "ads_management", "business_management", "pages_show_list", "pages_read_engagement"];

function resolveUserId(idOrEmail) {
  if (!idOrEmail.includes("@")) return idOrEmail;
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(idOrEmail);
  if (!row) throw new Error(`No user found with email "${idOrEmail}".`);
  return row.id;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/debugMetaToken.js <userId-or-email>");
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

  const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;

  const debugUrl = new URL(`https://graph.facebook.com/${API_VERSION}/debug_token`);
  debugUrl.searchParams.set("input_token", conn.accessToken);
  debugUrl.searchParams.set("access_token", appToken);
  const debugJson = await (await fetch(debugUrl)).json();
  const info = debugJson.data || {};

  // debug_token's `scopes` only lists what's currently granted — it does not
  // distinguish "never asked" from "asked and declined". /me/permissions
  // (authenticated with the USER's own token, not the app token) is the
  // endpoint that actually separates granted vs declined vs expired.
  const permsUrl = new URL(`https://graph.facebook.com/${API_VERSION}/me/permissions`);
  permsUrl.searchParams.set("access_token", conn.accessToken);
  const permsJson = await (await fetch(permsUrl)).json();
  const permsList = permsJson.data || [];

  const grantedFromDebug = new Set(info.scopes || []);
  const grantedFromPerms = new Set(permsList.filter((p) => p.status === "granted").map((p) => p.permission));
  const declined = permsList.filter((p) => p.status === "declined").map((p) => p.permission);
  const expiredPerms = permsList.filter((p) => p.status === "expired").map((p) => p.permission);

  console.log("=== Meta Token Diagnostic — read-only, token never printed ===\n");

  if (debugJson.error) {
    console.log("debug_token call FAILED:", debugJson.error.message);
    console.log("(This alone is informative — an error here, e.g. \"Invalid OAuth access token\", means the stored token is already invalid, independent of any specific scope question.)\n");
  } else {
    console.log("1. Valid:", info.is_valid === true ? "YES" : "NO");
    console.log("2. Facebook user ID on token:", info.user_id || "(not returned)");
    console.log("3. App ID on token:", info.app_id || "(not returned)");
    console.log("   Configured META_APP_ID:", process.env.META_APP_ID);
    console.log("   App ID matches META_APP_ID:", String(info.app_id) === String(process.env.META_APP_ID) ? "YES" : "NO — MISMATCH");
    console.log(
      "4. Expiry:",
      info.expires_at === 0
        ? "never expires (long-lived, no set expiry)"
        : info.expires_at
        ? new Date(info.expires_at * 1000).toISOString()
        : "(not returned)"
    );
    console.log("5. Granted scopes (debug_token):", (info.scopes || []).join(", ") || "(none returned)");
  }

  console.log("\n6. Required-scope check (debug_token OR /me/permissions='granted'):");
  for (const scope of REQUIRED_SCOPES) {
    const granted = grantedFromDebug.has(scope) || grantedFromPerms.has(scope);
    console.log(`   ${scope.padEnd(24)} ${granted ? "GRANTED" : "MISSING"}`);
  }

  console.log("\n7. Declined permissions (/me/permissions):", declined.length ? declined.join(", ") : "(none)");
  console.log("   Expired permissions (/me/permissions):", expiredPerms.length ? expiredPerms.join(", ") : "(none)");

  if (permsJson.error) {
    console.log("\n/me/permissions call FAILED:", permsJson.error.message);
  }

  console.log("\nDB scopes column (what was REQUESTED at OAuth time, not verified — see audit):");
  console.log("  ", JSON.stringify(JSON.parse(db.prepare("SELECT scopes FROM integrations WHERE userId = ? AND provider = 'meta_ads' AND orgId IS NULL").get(userId)?.scopes || "[]")));
}

main().catch((err) => {
  console.error("Diagnostic failed:", err.message);
  process.exit(1);
});
