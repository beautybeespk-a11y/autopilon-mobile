// API usage dashboard aggregation (Phase 17 §22) — reads api_request_logs
// (written by publicApi/requestLog.js on every v1 request). Read-only
// reporting only; nothing here enforces anything, that's rateLimit.js/
// billing.js's job.
import db from "../db.js";

export function getApiUsageDashboard(orgId, { sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  const totals = db.prepare(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS errors,
            AVG(latencyMs) AS avgLatencyMs
     FROM api_request_logs WHERE orgId = ? AND createdAt > ?`
  ).get(orgId, since);

  const byDay = db.prepare(
    `SELECT substr(createdAt, 1, 10) AS day, COUNT(*) AS requests
     FROM api_request_logs WHERE orgId = ? AND createdAt > ? GROUP BY day ORDER BY day ASC`
  ).all(orgId, since);

  const byEndpoint = db.prepare(
    `SELECT method, path, COUNT(*) AS requests, AVG(latencyMs) AS avgLatencyMs
     FROM api_request_logs WHERE orgId = ? AND createdAt > ? GROUP BY method, path ORDER BY requests DESC LIMIT 20`
  ).all(orgId, since);

  const byKey = db.prepare(
    `SELECT l.apiKeyId, k.name AS keyName, COUNT(*) AS requests
     FROM api_request_logs l LEFT JOIN developer_api_keys k ON k.id = l.apiKeyId
     WHERE l.orgId = ? AND l.createdAt > ? GROUP BY l.apiKeyId ORDER BY requests DESC LIMIT 20`
  ).all(orgId, since);

  const byErrorCode = db.prepare(
    `SELECT errorCode, COUNT(*) AS count FROM api_request_logs
     WHERE orgId = ? AND createdAt > ? AND errorCode IS NOT NULL GROUP BY errorCode ORDER BY count DESC LIMIT 20`
  ).all(orgId, since);

  const agentExecutions = db.prepare(
    "SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM api_agent_runs WHERE orgId = ? AND createdAt > ?"
  ).get(orgId, since);

  return {
    periodDays: sinceDays,
    requests: totals.requests || 0,
    errors: totals.errors || 0,
    errorRate: totals.requests ? Math.round(((totals.errors || 0) / totals.requests) * 1000) / 10 : 0,
    avgLatencyMs: totals.avgLatencyMs ? Math.round(totals.avgLatencyMs) : null,
    requestsByDay: byDay,
    topEndpoints: byEndpoint.map((r) => ({ ...r, avgLatencyMs: r.avgLatencyMs ? Math.round(r.avgLatencyMs) : null })),
    byApiKey: byKey.map((r) => ({ apiKeyId: r.apiKeyId, keyName: r.keyName || "(revoked key)", requests: r.requests })),
    errorsByCode: byErrorCode,
    agentExecutions: { total: agentExecutions.count || 0, failed: agentExecutions.failed || 0 },
  };
}

// Platform-wide version of the dashboard above (Phase 17 §57) — same
// queries, no orgId filter, plus the cross-org rollups (top organizations,
// webhook failures by org) an org-scoped dashboard has no reason to need.
// Read-only, platform-admin-only (enforced by the route, not here); never
// touches hashedSecret/encryptedSecret — nothing in this file can leak one,
// since it only ever SELECTs aggregate counts and identifying metadata.
export function getPlatformApiUsageDashboard({ sinceDays = 7 } = {}) {
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();

  const totals = db.prepare(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) AS errors,
            AVG(latencyMs) AS avgLatencyMs
     FROM api_request_logs WHERE createdAt > ?`
  ).get(since);

  const topEndpoints = db.prepare(
    `SELECT method, path, COUNT(*) AS requests, AVG(latencyMs) AS avgLatencyMs
     FROM api_request_logs WHERE createdAt > ? GROUP BY method, path ORDER BY requests DESC LIMIT 20`
  ).all(since);

  const topOrgs = db.prepare(
    `SELECT l.orgId, o.name AS orgName, COUNT(*) AS requests,
            SUM(CASE WHEN l.statusCode >= 400 THEN 1 ELSE 0 END) AS errors
     FROM api_request_logs l LEFT JOIN organizations o ON o.id = l.orgId
     WHERE l.createdAt > ? AND l.orgId IS NOT NULL
     GROUP BY l.orgId ORDER BY requests DESC LIMIT 20`
  ).all(since);

  const errorsByCode = db.prepare(
    `SELECT errorCode, COUNT(*) AS count FROM api_request_logs
     WHERE createdAt > ? AND errorCode IS NOT NULL GROUP BY errorCode ORDER BY count DESC LIMIT 20`
  ).all(since);

  const rateLimitEvents = db.prepare(
    `SELECT COUNT(*) AS count FROM api_request_logs WHERE createdAt > ? AND errorCode = 'RATE_LIMITED'`
  ).get(since).count || 0;

  const webhookDeliveriesByStatus = db.prepare(
    `SELECT status, COUNT(*) AS count FROM webhook_deliveries WHERE createdAt > ? GROUP BY status`
  ).all(since);

  const topOrgsByWebhookFailures = db.prepare(
    `SELECT w.orgId, o.name AS orgName, COUNT(*) AS failures
     FROM webhook_deliveries d JOIN developer_webhooks w ON w.id = d.webhookId
     LEFT JOIN organizations o ON o.id = w.orgId
     WHERE d.createdAt > ? AND d.status IN ('failed', 'dead_letter')
     GROUP BY w.orgId ORDER BY failures DESC LIMIT 20`
  ).all(since);

  const activeApiKeys = db.prepare("SELECT COUNT(*) AS count FROM developer_api_keys WHERE status = 'active'").get().count || 0;
  const activeWebhooks = db.prepare("SELECT COUNT(*) AS count FROM developer_webhooks WHERE status = 'active'").get().count || 0;

  return {
    periodDays: sinceDays,
    requests: totals.requests || 0,
    errors: totals.errors || 0,
    errorRate: totals.requests ? Math.round(((totals.errors || 0) / totals.requests) * 1000) / 10 : 0,
    avgLatencyMs: totals.avgLatencyMs ? Math.round(totals.avgLatencyMs) : null,
    rateLimitEvents,
    activeApiKeys,
    activeWebhooks,
    topEndpoints: topEndpoints.map((r) => ({ ...r, avgLatencyMs: r.avgLatencyMs ? Math.round(r.avgLatencyMs) : null })),
    topOrganizations: topOrgs.map((r) => ({ orgId: r.orgId, orgName: r.orgName || "(deleted org)", requests: r.requests, errors: r.errors || 0 })),
    errorsByCode,
    webhookDeliveriesByStatus,
    topOrgsByWebhookFailures: topOrgsByWebhookFailures.map((r) => ({ orgId: r.orgId, orgName: r.orgName || "(deleted org)", failures: r.failures })),
  };
}

export function listApiRequestLogs(orgId, { limit = 50, apiKeyId } = {}) {
  const clauses = ["orgId = ?"];
  const params = [orgId];
  if (apiKeyId) { clauses.push("apiKeyId = ?"); params.push(apiKeyId); }
  return db.prepare(
    `SELECT id, requestId, method, path, statusCode, latencyMs, errorCode, apiKeyId, createdAt
     FROM api_request_logs WHERE ${clauses.join(" AND ")} ORDER BY createdAt DESC LIMIT ?`
  ).all(...params, Math.min(limit, 200));
}
