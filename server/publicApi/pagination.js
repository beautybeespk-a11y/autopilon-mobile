// Cursor-based pagination (Phase 17 §28) shared by every v1 list endpoint —
// one scheme, not a per-endpoint reinvention, so cursors are opaque and
// endpoint-agnostic as long as the underlying query is ordered
// `createdAt DESC, id DESC` (cursorWhereClause() assumes exactly that sort).
export function parsePagination(req, { maxLimit = 100, defaultLimit = 20 } = {}) {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), maxLimit) : defaultLimit;
  let cursor = null;
  if (req.query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(String(req.query.cursor), "base64url").toString("utf8"));
      if (decoded?.createdAt && decoded?.id) cursor = decoded;
    } catch {
      // Malformed/tampered cursor — treated as no cursor (first page) rather
      // than a 400, since a stale/garbled cursor shouldn't hard-fail a client.
    }
  }
  return { limit, cursor };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id }), "utf8").toString("base64url");
}

// Query for LIMIT (limit + 1) rows, pass all of them in here — the extra
// row (if present) is how "hasMore" is known without a separate COUNT(*).
export function paginate(rows, limit) {
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const nextCursor = hasMore && data.length ? encodeCursor(data[data.length - 1]) : null;
  return { data, pagination: { nextCursor, hasMore, limit } };
}

export function cursorWhereClause(cursor) {
  if (!cursor) return { sql: "", params: [] };
  return { sql: "AND (createdAt < ? OR (createdAt = ? AND id < ?))", params: [cursor.createdAt, cursor.createdAt, cursor.id] };
}
