import { getConnection, saveConnection } from "../manager.js";
import { refreshAccessToken } from "./oauth.js";
import db from "../../db.js";
import { logActivity } from "../../middleware.js";

// Centralizes "is the token expired, refresh if so, persist the new one" for
// all four Calendar/Drive/Docs/Sheets tools, same pattern as Gmail's api.js.
export async function getValidAccessToken(userId, service, label) {
  const conn = getConnection(userId, service);
  if (!conn || conn.status !== "connected") {
    const err = new Error(`${label} is not connected. Connect it first in Integrations.`);
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  const expired = conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) < new Date(Date.now() + 60_000);
  if (!expired) return conn.accessToken;

  const refreshed = await refreshAccessToken(conn.refreshToken);
  // Phase 18.2 §7: same disconnect-during-refresh race as gmail/api.js's
  // getValidAccessToken() — re-check the connection is still connected
  // before persisting, so a disconnect that happened while this refresh's
  // network call was in flight can't be resurrected by this write.
  const stillConnected = getConnection(userId, service);
  if (!stillConnected || stillConnected.status !== "connected") {
    const err = new Error(`${label} is not connected. Connect it first in Integrations.`);
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  const meta = JSON.parse(conn.meta || "{}");
  saveConnection(userId, service, {
    accessToken: refreshed.accessToken,
    refreshToken: conn.refreshToken, // Google doesn't reissue this on refresh
    expiresAt: refreshed.expiresAt,
    scopes: JSON.parse(conn.scopes || "[]"),
    meta,
  });
  logActivity(db, userId, "integration_refreshed", `Refreshed ${label} access token`); // Phase 18.2 §11 — never logs a token value
  return refreshed.accessToken;
}
