// Logs one row per public API request (Phase 17 §25) into api_request_logs
// — the source of truth for the Developer Console's usage dashboard and
// the admin analytics extension (Tasks 51/57 read this; this file only
// ever writes it). Mounted after requireApiKey so req.apiKey/req.orgId are
// available, but registers its res.on('finish') listener regardless of
// whether auth ultimately succeeded, so failed-auth attempts are logged too
// (apiKeyId/orgId just end up null for those rows).
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

export function requestLog(req, res, next) {
  const startedAt = Date.now();
  res.on("finish", () => {
    try {
      db.prepare(
        `INSERT INTO api_request_logs (id, apiKeyId, orgId, requestId, method, path, statusCode, latencyMs, errorCode, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        cryptoRandom(), req.apiKey?.id || null, req.orgId || null, req.requestId || null,
        req.method, req.baseUrl + (req.route?.path || req.path), res.statusCode,
        Date.now() - startedAt, req._apiErrorCode || null, new Date().toISOString()
      );
    } catch {
      // Logging must never be able to take down a request that otherwise
      // succeeded — a write failure here (e.g. a full disk) is swallowed,
      // not surfaced to the caller who already got their real response.
    }
  });
  next();
}
