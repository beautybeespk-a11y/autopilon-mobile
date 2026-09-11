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
  // Round 38 fix (found while chasing an intermittent test failure — a
  // real, reproducible bug, not just a test artifact): createdAt is
  // millisecond-resolution (new Date().toISOString()), and two rows for
  // the same conversation can legitimately share the same millisecond —
  // build_strategy immediately followed by revise_strategy, both fast,
  // synchronous, in-process calls, is exactly the shape that produces
  // this. Without a tiebreaker, "ORDER BY createdAt DESC" has no defined
  // order between tied rows — SQLite can return EITHER one, and did:
  // caught returning the OLDER (now-superseded) row instead of the
  // actually-most-recent one. rowid (SQLite's own implicit, monotonically
  // increasing insert-order column — real here since `id` is a TEXT
  // primary key, never aliased to rowid) is a reliable secondary sort key
  // that createdAt alone can never be.
  const found = row(
    db.prepare(
      "SELECT * FROM meta_v2_strategies WHERE userId = ? AND conversationId = ? AND status IN ('proposed','approved') ORDER BY createdAt DESC, rowid DESC LIMIT 1"
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

// Live bug (round 31): getActiveStrategyForConversation above has a hard
// status IN ('proposed','approved') filter by design — once a strategy is
// executed, it structurally CANNOT be found there again. That's exactly
// right for "is there something waiting to be approved," but it means
// nothing could ever distinguish "no strategy was ever built for this
// conversation" from "a strategy was built AND already executed" — a
// second approval attempt (idempotency working correctly) got the SAME
// generic "no active strategy... call build_strategy first" message as a
// conversation where nothing had ever happened, which then led the model
// to improvise "let me rebuild the strategy due to a technical issue."
// No status filter here on purpose — answers "what's the most recent
// strategy for this conversation, in whatever state it's actually in."
export function getMostRecentStrategyForConversation(userId, conversationId) {
  if (!conversationId) return null;
  // Round 38 fix — same rowid tiebreaker as getActiveStrategyForConversation
  // above, for the identical reason (see that function's comment). This
  // one matters even more here: round 38's build_strategy redirect and
  // round 37's revise_strategy fallback both rely on this to find the
  // genuinely most recent strategy — a millisecond createdAt tie
  // returning the wrong (older) row here would silently resurrect a
  // stale/superseded strategy's fields instead of the real current ones.
  return row(
    db.prepare("SELECT * FROM meta_v2_strategies WHERE userId = ? AND conversationId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1").get(userId, conversationId)
  );
}

// Round 37 fix — a revision of an ALREADY-EXECUTED strategy is now
// permitted (see reviseStrategy, strategyBuilder.js) specifically so the
// creative/audience/budget already resolved on it survives an unrelated
// targeting change instead of being silently re-derived from scratch.
// That new revision row must never let execute_strategy silently create
// a SECOND, real campaign in Meta — this is the shared lookup both
// checkV2ExecutionApprovalGate (orchestrator/index.js, the pre-dispatch
// gate) and executeStrategy's own defense-in-depth check (executor.js)
// call to detect that case; lives here (not in either caller) because
// both need it and neither may import from the other. Walks the
// revisionOf chain, not just the immediate parent — a strategy can be
// revised more than once after execution, and each new revision's own
// revisionOf points at the PREVIOUS revision, not the original executed
// row. Bounded to guard against a pathological/corrupted chain looping
// forever; a real chain is never anywhere near this deep.
const MAX_REVISION_CHAIN_WALK = 20;
export function getExecutedAncestorStrategy(userId, strategy) {
  let current = strategy;
  let hops = 0;
  while (current?.revisionOf && hops < MAX_REVISION_CHAIN_WALK) {
    const parent = getStoredStrategy(userId, current.revisionOf);
    if (!parent) return null;
    if (parent.status === "executed") return parent;
    current = parent;
    hops++;
  }
  return null;
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
  // Round 38 — same rowid tiebreaker as the functions above, so a
  // millisecond createdAt tie never makes an investigation's "most
  // recent first" ordering misleading.
  return db
    .prepare("SELECT id, conversationId, status, createdAt, updatedAt, revisionOf FROM meta_v2_strategies WHERE userId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?")
    .all(userId, limit);
}
