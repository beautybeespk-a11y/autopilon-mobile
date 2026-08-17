// Idempotency-Key support for Public API write endpoints (Phase 17.1 §1).
// An HTTP-layer request/response cache in front of the existing route
// handlers — deliberately NOT a second job/queue system. Async agent
// execution's own Job Manager enqueue is untouched; this middleware just
// makes the ENTIRE HTTP request (including the 202 "queued" response
// itself) replayable, which is sufficient to prevent a client's retried
// POST from triggering a second enqueue.
//
// Optional: an endpoint with this middleware still works exactly as before
// for a caller that never sends the header — this only activates when a
// client opts in.
import crypto from "crypto";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { apiError } from "./errors.js";

const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000; // 24h — matches Stripe's convention, long enough to cover realistic client retry windows

function requestHash(req) {
  return crypto.createHash("sha256").update(JSON.stringify({ method: req.method, path: req.originalUrl, body: req.body || {} })).digest("hex");
}

export function idempotent() {
  return (req, res, next) => {
    const key = req.get("Idempotency-Key");
    if (!key) return next();
    if (key.length > 255) return apiError(res, 400, "INVALID_REQUEST", "Idempotency-Key must be 255 characters or fewer.");

    const hash = requestHash(req);
    const existing = db.prepare("SELECT * FROM api_idempotency_keys WHERE apiKeyId = ? AND idempotencyKey = ?").get(req.apiKey.id, key);

    if (existing) {
      if (existing.expiresAt <= new Date().toISOString()) {
        // Expired — treat as if it never existed. Delete-then-fall-through
        // to the reservation path below (same INSERT, now safe to succeed).
        db.prepare("DELETE FROM api_idempotency_keys WHERE id = ?").run(existing.id);
      } else if (existing.requestHash !== hash) {
        return apiError(res, 409, "IDEMPOTENCY_KEY_CONFLICT", "This Idempotency-Key was already used with a different request.");
      } else if (existing.status === "completed") {
        res.set("Idempotency-Replayed", "true");
        return res.status(existing.statusCode).json(JSON.parse(existing.responseBody));
      } else {
        // status === 'in_progress' — a genuinely concurrent duplicate
        // request, still being handled. Reject rather than double-execute.
        return apiError(res, 409, "IDEMPOTENCY_KEY_IN_PROGRESS", "A request with this Idempotency-Key is already being processed. Retry shortly.");
      }
    }

    // Reserve the key BEFORE the handler runs. The UNIQUE index on
    // (apiKeyId, idempotencyKey) is what actually makes this race-safe: if
    // two requests reach this exact point concurrently, only one INSERT can
    // win — the loser falls into the catch below and is told to back off,
    // never proceeds to execute the handler.
    const id = cryptoRandom();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();
    try {
      db.prepare(
        `INSERT INTO api_idempotency_keys (id, apiKeyId, orgId, idempotencyKey, requestHash, status, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`
      ).run(id, req.apiKey.id, req.orgId, key, hash, now, expiresAt);
    } catch {
      const race = db.prepare("SELECT requestHash FROM api_idempotency_keys WHERE apiKeyId = ? AND idempotencyKey = ?").get(req.apiKey.id, key);
      if (race && race.requestHash === hash) {
        return apiError(res, 409, "IDEMPOTENCY_KEY_IN_PROGRESS", "A request with this Idempotency-Key is already being processed. Retry shortly.");
      }
      return apiError(res, 409, "IDEMPOTENCY_KEY_CONFLICT", "This Idempotency-Key was already used with a different request.");
    }

    // Capture exactly what the client receives. A 5xx is deliberately NOT
    // cached — an internal error means we don't actually know whether the
    // underlying operation succeeded, so locking the client out of a real
    // retry for 24h would be worse than the (small) risk of a genuine
    // duplicate on a request that never got a real answer either way.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        if (res.statusCode >= 500) {
          db.prepare("DELETE FROM api_idempotency_keys WHERE id = ?").run(id);
        } else {
          db.prepare("UPDATE api_idempotency_keys SET status = 'completed', statusCode = ?, responseBody = ? WHERE id = ?")
            .run(res.statusCode, JSON.stringify(body), id);
        }
      } catch {
        // Best-effort — a logging/caching failure must never take down a
        // request whose real handler already succeeded.
      }
      return originalJson(body);
    };
    next();
  };
}

export function sweepExpiredIdempotencyKeys() {
  db.prepare("DELETE FROM api_idempotency_keys WHERE expiresAt < ?").run(new Date().toISOString());
}
