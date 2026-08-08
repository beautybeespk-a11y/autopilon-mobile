import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { hasPermission } from "../orchestrator/rbac.js";

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

// Phase 9: Shared Integrations. Resolution order — if the user is currently
// "in" an organization (users.activeOrgId, set by switching orgs) AND that
// org has its own connected integration for this provider AND the user has
// 'integrations' permission there, use the ORG'S connection. Otherwise fall
// back to the user's own personal connection — exactly the only behavior
// that existed before this was added, so nothing changes for anyone who
// never touches organizations. Signature is unchanged on purpose: every
// existing tool file calls getConnection(userId, provider) and gets this
// for free, with zero changes needed on their end.
export function getConnection(userId, provider) {
  const user = db.prepare("SELECT activeOrgId FROM users WHERE id = ?").get(userId);
  if (user?.activeOrgId) {
    const orgConn = db.prepare("SELECT * FROM integrations WHERE orgId = ? AND provider = ? AND status = 'connected'").get(user.activeOrgId, provider);
    if (orgConn) {
      if (hasPermission(user.activeOrgId, userId, "integrations")) return orgConn;
    }
  }
  return db.prepare("SELECT * FROM integrations WHERE userId = ? AND provider = ? AND orgId IS NULL").get(userId, provider);
}

// Upserts the connection row for (userId, provider). Never logs the token
// values themselves — callers pass them in, this only ever writes to the DB.
export function saveConnection(userId, provider, { accessToken, refreshToken, expiresAt, scopes, meta }) {
  const existing = db.prepare("SELECT * FROM integrations WHERE userId = ? AND provider = ? AND orgId IS NULL").get(userId, provider);
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
    "UPDATE integrations SET status = 'not_connected', accessToken = NULL, refreshToken = NULL, tokenExpiresAt = NULL, updatedAt = ? WHERE userId = ? AND provider = ? AND orgId IS NULL"
  ).run(now(), userId, provider);
}

// --- Org-level connections (Shared Integrations) — a parallel, explicit
// set of functions rather than overloading the personal ones above, so a
// route has to deliberately opt into creating an org-shared connection
// rather than it happening as a side effect of some default parameter. ---
export function getOrgConnection(orgId, provider) {
  return db.prepare("SELECT * FROM integrations WHERE orgId = ? AND provider = ?").get(orgId, provider);
}

export function listOrgConnections(orgId) {
  return db.prepare("SELECT * FROM integrations WHERE orgId = ?").all(orgId);
}

export function saveOrgConnection(orgId, connectedByUserId, provider, { accessToken, refreshToken, expiresAt, scopes, meta }) {
  const existing = getOrgConnection(orgId, provider);
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
    `INSERT INTO integrations (id, userId, orgId, provider, status, accessToken, refreshToken, tokenExpiresAt, scopes, meta, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, connectedByUserId, orgId, provider, accessToken, refreshToken || null, expiresAt || null, scopesJson, metaJson, now(), now());
  return id;
}

export function disconnectOrgConnection(orgId, provider) {
  db.prepare(
    "UPDATE integrations SET status = 'not_connected', accessToken = NULL, refreshToken = NULL, tokenExpiresAt = NULL, updatedAt = ? WHERE orgId = ? AND provider = ?"
  ).run(now(), orgId, provider);
}

export function connectionHealth(userId, provider) {
  const conn = getConnection(userId, provider);
  if (!conn || conn.status !== "connected" || !conn.accessToken) {
    return { connected: false, reason: "Not connected" };
  }
  if (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) < new Date()) {
    return { connected: false, reason: "Access token expired", expired: true };
  }
  return { connected: true, sharedFromOrg: Boolean(conn.orgId) };
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
