// Meta Ads Expert V2 — strategy persistence (Step 14). One row per
// build_strategy/revise_strategy call that actually validates — a failed
// attempt is never stored at all (Step 7: no draft-repair-loop rows to
// track), matching this table's comment in db.js.
import db from "../../db.js";
import { cryptoRandom } from "../../middleware.js";
import { trace } from "./diagnostics.js";

export const EXECUTABLE_STATUSES = new Set(["proposed", "approved"]);

function row(r) {
  if (!r) return null;
  return {
    ...r,
    strategy: JSON.parse(r.strategyJson),
    resolvedAssets: JSON.parse(r.resolvedAssetsJson),
    snapshot: r.snapshotJson ? JSON.parse(r.snapshotJson) : null,
    executionResult: r.executionResultJson ? JSON.parse(r.executionResultJson) : null,
  };
}

// Any OTHER strategy for this same user+conversation still sitting in
// 'proposed'/'approved' is marked 'superseded' before the new one is
// inserted — a fresh build/revise call always means either a genuinely new
// concept or a revision, never two simultaneously-live proposals a stale
// id could later be confused between (same reasoning as V1's
// meta_campaign_plans supersede behavior).
export function insertStrategy({ userId, conversationId, mode, strategy, resolved, names, snapshotVersion, snapshot, recommendationText, revisionOf = null }) {
  const now = new Date().toISOString();
  if (conversationId) {
    db.prepare("UPDATE meta_v2_strategies SET status = 'superseded', updatedAt = ? WHERE userId = ? AND conversationId = ? AND status IN ('proposed','approved')")
      .run(now, userId, conversationId);
  }
  const id = cryptoRandom();
  const resolvedAssets = { ...resolved, ...names };
  db.prepare(
    `INSERT INTO meta_v2_strategies
      (id, userId, conversationId, status, mode, strategyJson, resolvedAssetsJson, snapshotVersion, snapshotJson, recommendationText, revisionOf, createdAt, updatedAt)
     VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, conversationId || null, mode, JSON.stringify(strategy), JSON.stringify(resolvedAssets), snapshotVersion || null, snapshot ? JSON.stringify(snapshot) : null, recommendationText || null, revisionOf, now, now);
  // TEMPORARY diagnostic (live bug: creative revision gate can't find the
  // active strategy — investigating persistence/conversationId linkage).
  // No strategyJson/secrets — just the identifying columns requested.
  // Note: this table has NO orgId column at all (see db.js's CREATE TABLE)
  // — never captured at write time, so it can't be logged here either.
  trace("strategy persisted", { strategyId: id, userId, conversationId: conversationId || null, status: "proposed", mode, revisionOf: revisionOf || null, createdAt: now });
  return getStoredStrategy(userId, id);
}

export function getStoredStrategy(userId, strategyId) {
  return row(db.prepare("SELECT * FROM meta_v2_strategies WHERE id = ? AND userId = ?").get(strategyId, userId));
}

export function getActiveStrategyForConversation(userId, conversationId) {
  if (!conversationId) {
    // TEMPORARY diagnostic — a null/undefined conversationId here means
    // whatever called this (ultimately the chat route) never had one to
    // pass, which alone would explain "no active strategy found."
    trace("getActiveStrategyForConversation: called with no conversationId", { userId });
    return null;
  }
  const found = row(
    db.prepare(
      "SELECT * FROM meta_v2_strategies WHERE userId = ? AND conversationId = ? AND status IN ('proposed','approved') ORDER BY createdAt DESC LIMIT 1"
    ).get(userId, conversationId)
  );
  // TEMPORARY diagnostic (live bug: creative revision gate can't find the
  // active strategy). Logs exactly what this lookup searched for and what
  // it found — the direct comparison point between the conversationId the
  // strategy was BUILT under and the conversationId the CURRENT turn is
  // querying with. No strategyJson/secrets.
  trace("getActiveStrategyForConversation", {
    userId, queriedConversationId: conversationId,
    found: Boolean(found), foundStrategyId: found?.id || null, foundStatus: found?.status || null, foundConversationId: found?.conversationId || null,
  });
  return found;
}

export function setStrategyStatus(strategyId, status) {
  db.prepare("UPDATE meta_v2_strategies SET status = ?, updatedAt = ? WHERE id = ?").run(status, new Date().toISOString(), strategyId);
}

export function markStrategyApproved(strategyId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE meta_v2_strategies SET status = 'approved', approvedAt = ?, updatedAt = ? WHERE id = ?").run(now, now, strategyId);
}

export function markStrategyExecuted(strategyId, executionResult) {
  const now = new Date().toISOString();
  db.prepare("UPDATE meta_v2_strategies SET status = 'executed', executionResultJson = ?, executedAt = ?, updatedAt = ? WHERE id = ?")
    .run(JSON.stringify(executionResult), now, now, strategyId);
}

export function markStrategyFailed(strategyId, reason) {
  db.prepare("UPDATE meta_v2_strategies SET status = 'failed', executionResultJson = ?, updatedAt = ? WHERE id = ?")
    .run(JSON.stringify({ error: reason }), new Date().toISOString(), strategyId);
}

export function markStrategyRejected(strategyId) {
  setStrategyStatus(strategyId, "rejected");
}

// Read-only diagnostic helper (live bug investigation) — deliberately
// returns ONLY identifying columns, never strategyJson/resolvedAssetsJson/
// snapshotJson (which can contain business data) — safe to print/share.
// Not called from any production code path; exists for direct invocation
// during an investigation (see the node one-liner in the incident notes).
export function listRecentStrategiesForUser(userId, limit = 10) {
  return db
    .prepare("SELECT id, conversationId, status, createdAt, updatedAt, revisionOf FROM meta_v2_strategies WHERE userId = ? ORDER BY createdAt DESC LIMIT ?")
    .all(userId, limit);
}
