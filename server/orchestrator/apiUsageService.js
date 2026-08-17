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

export function listApiRequestLogs(orgId, { limit = 50, apiKeyId } = {}) {
  const clauses = ["orgId = ?"];
  const params = [orgId];
  if (apiKeyId) { clauses.push("apiKeyId = ?"); params.push(apiKeyId); }
  return db.prepare(
    `SELECT id, requestId, method, path, statusCode, latencyMs, errorCode, apiKeyId, createdAt
     FROM api_request_logs WHERE ${clauses.join(" AND ")} ORDER BY createdAt DESC LIMIT ?`
  ).all(...params, Math.min(limit, 200));
}
