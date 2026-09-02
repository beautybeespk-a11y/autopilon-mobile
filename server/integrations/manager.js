import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { hasPermission } from "../orchestrator/rbac.js";
import { encryptSecret, decryptSecret } from "../orchestrator/secretsCrypto.js";
import { logger } from "../config/logger.js";

// Phase 18.1 §1 — accessToken/refreshToken are real, long-lived credentials
// (OAuth tokens, WordPress application passwords, WooCommerce API secrets,
// Shopify manual tokens) that grant real access to a connected external
// account. Encrypted at rest with the same AES-256-GCM helper already used
// for BYOK provider keys and developer webhook signing secrets — nothing
// new invented, no plaintext token ever written to the `integrations`
// table from here on.
//
// Decryption is centralized in the three read functions below
// (getConnection/getOrgConnection/listOrgConnections), NOT scattered
// across every one of this app's ~12 call sites that read `.accessToken`
// off a connection row — every existing caller (gmail/api.js,
// google/tokenHelper.js, the shopify/woocommerce/wordpress health checks,
// requireValidToken(), connectionHealth(), etc.) keeps working completely
// unchanged, since by the time any of them see a connection row, its
// tokens are already plaintext again.
//
// Migration for pre-existing plaintext tokens (dev-only data, no real
// production users ever existed against this schema): decryptToken()
// below treats anything that fails to decrypt — including old plaintext
// values, which aren't even in the `iv:authTag:ciphertext` format this
// expects — as unreadable and returns null. connectionHealth() already
// treats a falsy accessToken as "not connected," so an old plaintext
// token silently becomes "please reconnect" rather than a crash or a
// silently-broken integration. This is the intended, safe migration
// path: reconnect once, the new token is encrypted, done.
function encryptToken(token) {
  if (!token) return null;
  return encryptSecret(token);
}

function decryptToken(stored, { provider } = {}) {
  if (!stored) return null;
  try {
    return decryptSecret(stored);
  } catch (err) {
    logger.warn("integrations.token_decrypt_failed", { provider: provider || null, reason: err.message });
    return null;
  }
}

// Applies decryptToken() to a raw `integrations` row's accessToken/
// refreshToken fields — every SELECT * FROM integrations read path routes
// through this so a caller always sees plaintext tokens (or null, if
// undecryptable) exactly as before this change.
function withDecryptedTokens(row) {
  if (!row) return row;
  return {
    ...row,
    accessToken: decryptToken(row.accessToken, { provider: row.provider }),
    refreshToken: decryptToken(row.refreshToken, { provider: row.provider }),
  };
}

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
      if (hasPermission(user.activeOrgId, userId, "integrations")) return withDecryptedTokens(orgConn);
    }
  }
  return withDecryptedTokens(db.prepare("SELECT * FROM integrations WHERE userId = ? AND provider = ? AND orgId IS NULL").get(userId, provider));
}

// Upserts the connection row for (userId, provider). Never logs the token
// values themselves — callers pass them in, this only ever writes to the DB.
// accessToken/refreshToken are encrypted here, right before they touch the
// database — everything upstream of this call still passes plaintext.
export function saveConnection(userId, provider, { accessToken, refreshToken, expiresAt, scopes, meta }) {
  const existing = db.prepare("SELECT * FROM integrations WHERE userId = ? AND provider = ? AND orgId IS NULL").get(userId, provider);
  const scopesJson = JSON.stringify(scopes || []);
  const metaJson = JSON.stringify(meta || {});
  const encryptedAccessToken = encryptToken(accessToken);
  const encryptedRefreshToken = encryptToken(refreshToken);
  if (existing) {
    db.prepare(
      `UPDATE integrations SET status = 'connected', accessToken = ?, refreshToken = COALESCE(?, refreshToken),
       tokenExpiresAt = ?, scopes = ?, meta = ?, updatedAt = ? WHERE id = ?`
    ).run(encryptedAccessToken, encryptedRefreshToken, expiresAt || null, scopesJson, metaJson, now(), existing.id);
    return existing.id;
  }
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO integrations (id, userId, provider, status, accessToken, refreshToken, tokenExpiresAt, scopes, meta, createdAt, updatedAt)
     VALUES (?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, provider, encryptedAccessToken, encryptedRefreshToken, expiresAt || null, scopesJson, metaJson, now(), now());
  return id;
}

// Merges `patch` into a connection's `meta` JSON blob (e.g. a saved
// default ad account id) WITHOUT touching accessToken/refreshToken/scopes
// — deliberately separate from saveConnection() so a per-user preference
// like this can never accidentally re-encrypt, clobber, or otherwise
// disturb the OAuth token itself. No-ops (does not create a row) if there's
// no connection to attach a preference to.
//
// CONFIRMED LIVE BUG (round 12): this used to ALWAYS write to the
// user's PERSONAL row (`orgId IS NULL`), while getConnection() above
// (Phase 9, Shared Integrations) reads the ORG's connection instead
// whenever the user is currently "in" an org with its own connected
// integration for this provider. For exactly that user, a saved Default
// Ad Account / Default Facebook Page set via routes/metaAuth.js's
// /default-ad-account /default-page (both: verify against getConnection(),
// then write via THIS function) landed on the personal row while every
// later resolveAdAccountId()/resolvePageId() call read the meta.defaults
// off the ORG row — the write and the read never touched the same row, so
// the "saved" default silently never took effect, with no error anywhere
// in the chain. Fixed by mirroring getConnection()'s exact resolution
// order: write to the SAME row it would read back.
export function updateConnectionMeta(userId, provider, patch) {
  const user = db.prepare("SELECT activeOrgId FROM users WHERE id = ?").get(userId);
  if (user?.activeOrgId) {
    const orgConn = db.prepare("SELECT * FROM integrations WHERE orgId = ? AND provider = ? AND status = 'connected'").get(user.activeOrgId, provider);
    if (orgConn && hasPermission(user.activeOrgId, userId, "integrations")) {
      const currentMeta = JSON.parse(orgConn.meta || "{}");
      const nextMeta = { ...currentMeta, ...patch };
      db.prepare("UPDATE integrations SET meta = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(nextMeta), now(), orgConn.id);
      return nextMeta;
    }
  }
  const existing = db.prepare("SELECT meta FROM integrations WHERE userId = ? AND provider = ? AND orgId IS NULL").get(userId, provider);
  if (!existing) return null;
  const currentMeta = JSON.parse(existing.meta || "{}");
  const nextMeta = { ...currentMeta, ...patch };
  db.prepare("UPDATE integrations SET meta = ?, updatedAt = ? WHERE userId = ? AND provider = ? AND orgId IS NULL")
    .run(JSON.stringify(nextMeta), now(), userId, provider);
  return nextMeta;
}

// Live bug: this cleared accessToken/refreshToken/tokenExpiresAt but left
// the `meta` column untouched — for WooCommerce, `meta.consumerKey` (the
// other half of the REST API credential pair; `consumerSecret` is what's
// stored as accessToken) survived disconnect indefinitely, in plaintext
// (meta is NOT covered by the AES-256-GCM encryption applied to accessToken/
// refreshToken above). WordPress's `meta.username` and Meta Ads' saved
// `meta.defaults` (pixelId/pageId/adAccountId/...) had the same gap, just
// lower sensitivity. Every disconnect route's own comment already claimed
// "local credentials are always still fully deleted" — true for the token,
// not for this. Reset to '{}' rather than NULL so every existing reader
// (all of which do `JSON.parse(conn.meta || "{}")`) keeps working exactly
// as if nothing were ever connected.
export function disconnectIntegration(userId, provider) {
  db.prepare(
    "UPDATE integrations SET status = 'not_connected', accessToken = NULL, refreshToken = NULL, tokenExpiresAt = NULL, meta = '{}', updatedAt = ? WHERE userId = ? AND provider = ? AND orgId IS NULL"
  ).run(now(), userId, provider);
}

// --- Org-level connections (Shared Integrations) — a parallel, explicit
// set of functions rather than overloading the personal ones above, so a
// route has to deliberately opt into creating an org-shared connection
// rather than it happening as a side effect of some default parameter. ---
// NOTE: returns the row with tokens still encrypted — getOrgConnection()'s
// own callers below decrypt it; this internal helper is also reused by
// saveOrgConnection() below, which only needs the row's id, never its
// tokens, so decrypting here would be pure waste.
function getOrgConnectionRaw(orgId, provider) {
  return db.prepare("SELECT * FROM integrations WHERE orgId = ? AND provider = ?").get(orgId, provider);
}

export function getOrgConnection(orgId, provider) {
  return withDecryptedTokens(getOrgConnectionRaw(orgId, provider));
}

export function listOrgConnections(orgId) {
  return db.prepare("SELECT * FROM integrations WHERE orgId = ?").all(orgId).map(withDecryptedTokens);
}

export function saveOrgConnection(orgId, connectedByUserId, provider, { accessToken, refreshToken, expiresAt, scopes, meta }) {
  const existing = getOrgConnectionRaw(orgId, provider);
  const scopesJson = JSON.stringify(scopes || []);
  const metaJson = JSON.stringify(meta || {});
  const encryptedAccessToken = encryptToken(accessToken);
  const encryptedRefreshToken = encryptToken(refreshToken);
  if (existing) {
    db.prepare(
      `UPDATE integrations SET status = 'connected', accessToken = ?, refreshToken = COALESCE(?, refreshToken),
       tokenExpiresAt = ?, scopes = ?, meta = ?, updatedAt = ? WHERE id = ?`
    ).run(encryptedAccessToken, encryptedRefreshToken, expiresAt || null, scopesJson, metaJson, now(), existing.id);
    return existing.id;
  }
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO integrations (id, userId, orgId, provider, status, accessToken, refreshToken, tokenExpiresAt, scopes, meta, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, connectedByUserId, orgId, provider, encryptedAccessToken, encryptedRefreshToken, expiresAt || null, scopesJson, metaJson, now(), now());
  return id;
}

// Same gap, same fix as disconnectIntegration() above — this is the
// org-shared-connection sibling of that function and had the identical
// bug (meta left behind after disconnect).
export function disconnectOrgConnection(orgId, provider) {
  db.prepare(
    "UPDATE integrations SET status = 'not_connected', accessToken = NULL, refreshToken = NULL, tokenExpiresAt = NULL, meta = '{}', updatedAt = ? WHERE orgId = ? AND provider = ?"
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
// Phase 18.2 §5: retryable = false — if this ever propagates all the way
// up to a Job Manager handler (rather than being caught per-tool-call),
// it needs the same "don't blindly retry" treatment jobs/handlers.js
// already gives a deleted/disabled webhook: no amount of retrying fixes
// "not connected" or "expired," only the user reconnecting does, so
// retrying just delays an inevitable dead-letter instead of failing
// cleanly and immediately.
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
    err.retryable = false;
    throw err;
  }
  return conn.accessToken;
}
