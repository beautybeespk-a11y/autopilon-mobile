import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

// Registry of integration *definitions* — metadata about what each provider
// offers. Connection *state* (tokens, status) lives in the integrations
// table, keyed by (userId, provider). Adding Gmail/Drive/WooCommerce/etc.
// later means: register a definition here, add its OAuth routes + tools,
// done — nothing else in the app changes.
const definitions = new Map();

export function registerIntegration(def) {
  if (!def?.id) throw new Error("Integration definition must have an id");
  definitions.set(def.id, {
    supportedTools: [],
    requiredScopes: [],
    authType: "oauth2",
    ...def,
  });
}

export function getIntegrationDefinition(id) {
  return definitions.get(id) || null;
}

export function listIntegrationDefinitions() {
  return Array.from(definitions.values());
}

function now() {
  return new Date().toISOString();
}

export function getConnection(userId, provider) {
  return db.prepare("SELECT * FROM integrations WHERE userId = ? AND provider = ?").get(userId, provider);
}

// Upserts the connection row for (userId, provider). Never logs the token
// values themselves — callers pass them in, this only ever writes to the DB.
export function saveConnection(userId, provider, { accessToken, refreshToken, expiresAt, scopes, meta }) {
  const existing = getConnection(userId, provider);
  const scopesJson = JSON.stringify(scopes || []);
  const metaJson = JSON.stringify(meta || {});
  if (existing) {
    db.prepare(
      `UPDATE integrations SET status = 'connected', accessToken = ?, refreshToken = COALESCE(?, refreshToken),
       tokenExpiresAt = ?, scopes = ?, meta = ?, updatedAt = ? WHERE id = ?`
    ).run(accessToken, refreshToken || null, expiresAt || null, scopesJson, metaJson, now(), existing.id);
    return existing.id;
  }
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO integrations (id, userId, provider, status, accessToken, refreshToken, tokenExpiresAt, scopes, meta, createdAt, updatedAt)
     VALUES (?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, provider, accessToken, refreshToken || null, expiresAt || null, scopesJson, metaJson, now(), now());
  return id;
}

export function disconnectIntegration(userId, provider) {
  db.prepare(
    "UPDATE integrations SET status = 'not_connected', accessToken = NULL, refreshToken = NULL, tokenExpiresAt = NULL, updatedAt = ? WHERE userId = ? AND provider = ?"
  ).run(now(), userId, provider);
}

export function connectionHealth(userId, provider) {
  const conn = getConnection(userId, provider);
  if (!conn || conn.status !== "connected" || !conn.accessToken) {
    return { connected: false, reason: "Not connected" };
  }
  if (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) < new Date()) {
    return { connected: false, reason: "Access token expired", expired: true };
  }
  return { connected: true };
}

// Returns a valid access token for the connection, or throws a clear error
// a tool's execute() can surface as a normal failed step (never a crash).
export function requireValidToken(userId, provider) {
  const conn = getConnection(userId, provider);
  const health = connectionHealth(userId, provider);
  if (!health.connected) {
    const err = new Error(
      health.expired
        ? `Your ${provider} connection has expired. Please reconnect it in Integrations.`
        : `${provider} is not connected. Connect it first in Integrations.`
    );
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  return conn.accessToken;
}
