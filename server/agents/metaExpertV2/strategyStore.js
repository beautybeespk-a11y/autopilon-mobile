// Meta Ads Expert V2 — strategy persistence (Step 14). One row per
// build_strategy/revise_strategy call that actually validates — a failed
// attempt is never stored at all (Step 7: no draft-repair-loop rows to
// track), matching this table's comment in db.js.
import db from "../../db.js";
import { cryptoRandom } from "../../middleware.js";
import { trace } from "./diagnostics.js";
import { fingerprintStrategy } from "./policy.js";

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
export function insertStrategy({ id: providedId = null, userId, conversationId, mode, strategy, resolved, names, snapshotVersion, snapshot, recommendationText, revisionOf = null }) {
  const now = new Date().toISOString();
  if (conversationId) {
    db.prepare("UPDATE meta_v2_strategies SET status = 'superseded', updatedAt = ? WHERE userId = ? AND conversationId = ? AND status IN ('proposed','approved')")
      .run(now, userId, conversationId);
  }
  // Stream C: the caller may supply the row id (runBuildOrRevise generates
  // it before building resolvedAssets.pendingQuestions, so a question's
  // askedStrategyId names the row that actually asked it). Otherwise a
  // fresh id is generated here, exactly as before.
  const id = providedId || cryptoRandom();
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

// Stream C (§3.1): a failed build/revise attempt is stored, never silently
// lost — the next turn can tell "asked, rejected, never applied" from "never
// asked". A failed attempt never supersedes and never becomes the "most
// recent" strategy: getMostRecentStrategyForConversation reads only
// meta_v2_strategies, so failed attempts are invisible to it by
// construction (this is why a separate table is required — a
// status='rejected' row in meta_v2_strategies could be mistaken for live
// context by buildStrategy's redirect).
export function insertFailedAttempt({ userId, conversationId, revisionOf = null, requestedChanges, discardedFields = [], errors, userMessage }) {
  const id = cryptoRandom();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO meta_v2_strategy_attempts
      (id, userId, conversationId, revisionOf, attemptedAt, requestedChangesJson, discardedFieldsJson, errorsJson, userMessage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, conversationId || null, revisionOf || null, now,
    JSON.stringify(requestedChanges || {}), JSON.stringify(discardedFields || []),
    JSON.stringify(errors || []), typeof userMessage === "string" ? userMessage.slice(0, 2000) : null);
  return id;
}

export function listFailedAttemptsForConversation(userId, conversationId, limit = 10) {
  return db.prepare(
    "SELECT * FROM meta_v2_strategy_attempts WHERE userId = ? AND conversationId = ? ORDER BY attemptedAt DESC, rowid DESC LIMIT ?"
  ).all(userId, conversationId, limit).map((r) => ({
    ...r,
    requestedChanges: JSON.parse(r.requestedChangesJson || "{}"),
    discardedFields: JSON.parse(r.discardedFieldsJson || "[]"),
    errors: JSON.parse(r.errorsJson || "[]"),
  }));
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

// Round 45 (edit-an-existing-campaign feature, campaignEditor.js) — the
// default target when a campaign edit doesn't name a specific strategyId:
// "the most recent campaign THIS conversation actually created in Meta."
// Deliberately a direct status='executed' filter, never
// getExecutedAncestorStrategy's revisionOf-walk below — that function
// assumes its INPUT is already one hop past the executed row (it checks
// `current.revisionOf`'s parent, never `current` itself), so feeding it
// the most-recent row when that row IS already the executed one would
// walk straight past it to whatever it was revised FROM instead. This is
// a plain, direct lookup: newest row with status='executed', full stop —
// same rowid tiebreaker discipline as every other lookup in this file.
export function getMostRecentExecutedStrategyForConversation(userId, conversationId) {
  if (!conversationId) return null;
  return row(
    db.prepare("SELECT * FROM meta_v2_strategies WHERE userId = ? AND conversationId = ? AND status = 'executed' ORDER BY createdAt DESC, rowid DESC LIMIT 1").get(userId, conversationId)
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

// DEPRECATED for the execute path — use recordStrategyApproval(); kept for campaignEditor.js (edit flow) only.
export function markStrategyApproved(strategyId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE meta_v2_strategies SET status = 'approved', approvedAt = ?, updatedAt = ? WHERE id = ?").run(now, now, strategyId);
}

// Stream B — record an approval BOUND to the exact strategy content approved.
// Replaces the old bare markStrategyApproved() for the execute path: status
// alone must never again mean "approved" without saying what was approved.
// Callers: executeStrategy() itself (fresh strong approval in this message),
// resumeAfterConfirmation() via recordExecutionApprovalForStrategy() below
// (card click / typed-approve resume). A later revise that changes the
// fingerprint leaves approvalFingerprint stale by design — hasValidApproval()
// below then returns false and a fresh approval is required (invariant I2).
export function recordStrategyApproval(strategyId, fingerprint, via) {
  const now = new Date().toISOString();
  db.prepare("UPDATE meta_v2_strategies SET status = 'approved', approvalFingerprint = ?, approvedVia = ?, approvedAt = ?, updatedAt = ? WHERE id = ?")
    .run(fingerprint, via || null, now, now, strategyId);
}

// Stream B — walk the revisionOf chain for a STALE approval: the nearest
// ancestor row that was ever approved, and the fingerprint it was approved
// with. A revise inserts a NEW row (status 'proposed', approvalFingerprint
// NULL — insertStrategy never copies the approval columns), so the revised
// row itself never carries a stale fingerprint; the "approved, then changed"
// signal only exists on the ancestor. Used by executeStrategy() to tell
// the user their earlier approval no longer covers the revised strategy
// (instead of the generic "not approved yet"). Same 20-hop bound as
// getExecutedAncestorStrategy (whose const is declared just above these
// helpers in strategyStore.js), for the same pathological-chain reason.
export function findStaleApprovalFingerprint(userId, stored) {
  let current = stored;
  let hops = 0;
  while (current?.revisionOf && hops < MAX_REVISION_CHAIN_WALK) {
    const parent = getStoredStrategy(userId, current.revisionOf);
    if (!parent) return null;
    if (typeof parent.approvalFingerprint === "string" && parent.approvalFingerprint.length > 0) return parent.approvalFingerprint;
    current = parent;
    hops++;
  }
  return null;
}

// Stream B — the ONLY approval predicate executeStrategy() may trust.
// True only when the row is 'approved' AND the fingerprint recorded at
// approval time still matches the CURRENT strategy content. A revise that
// changes any fingerprinted field (Patch 0) invalidates it, even though
// status may still read 'approved' until the next insert supersedes the row.
export function hasValidApproval(stored) {
  if (!stored || stored.status !== "approved") return false;
  if (!stored.approvalFingerprint) return false;
  return stored.approvalFingerprint === fingerprintStrategy(stored.strategy);
}

export function clearStrategyApproval(strategyId) {
  db.prepare("UPDATE meta_v2_strategies SET approvalFingerprint = NULL, approvedVia = NULL, updatedAt = ? WHERE id = ?")
    .run(new Date().toISOString(), strategyId);
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
