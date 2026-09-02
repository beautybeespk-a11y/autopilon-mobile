// Full account deletion — backs both the self-service "Delete my account"
// flow (Meta App Review expects this) and the admin "Remove access" action
// for a beta account (routes/platformAdmin.js). One core function so both
// entry points share the exact same safety checks and cleanup.
//
// PRAGMA foreign_keys = ON (db.js:11), so 28 of the 37 `REFERENCES
// users(id)` foreign keys already cascade-delete on `DELETE FROM users`.
// The other 9 declarations, across 8 tables, do NOT cascade (verified by a
// full-file scan of db.js, not sampled) and need explicit handling:
//   - marketplace_assets.creatorUserId, asset_purchases.buyerUserId,
//     asset_purchases.sellerUserId, custom_tools.creatorUserId,
//     coupon_codes.createdBy, organization_credits.grantedBy — all 6 of
//     these can reference DATA THAT BELONGS TO SOMEONE ELSE (a buyer's
//     purchase record, another org's granted credit, a tool other users'
//     agents may call) or, for the coupon/credit pair, are admin-only
//     actions where leaving them unblocked would let a platform admin's
//     own self-delete hit a raw, unhandled FK constraint error the first
//     time they'd ever created a coupon or granted credit. Silently
//     cascading these away would corrupt another user's data; silently
//     ignoring them would let the DELETE fail with an opaque SQLite error
//     partway through. Blocked instead, with a clear, specific reason —
//     never guessed, never partially applied (better-sqlite3 rolls the
//     whole transaction back on any throw).
//   - marketplace_installs.installedByUserId, asset_reviews.userId,
//     asset_reports.reporterUserId — these are the user's OWN
//     participation records (their own install, their own review, their
//     own report), safe to delete outright. Cleaned up explicitly below,
//     inside the same transaction as the final DELETE FROM users.
//
// asset_review_votes has no FK constraint declared at all (verified by
// reading its CREATE TABLE) — SQLite won't block on it, but leaving a
// departed user's votes behind would silently overcount reviews'
// helpfulCount forever. Cleaned up + recomputed below for the same reason
// recomputeAssetRating exists for reviews.
import db from "../db.js";
import { logActivity } from "../middleware.js";
import { deleteOrganization } from "./organizationManager.js";
import { recomputeAssetRating } from "./marketplaceReviews.js";

function countWhere(table, column, userId) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${column} = ?`).get(userId).c;
}

// Real, named blockers only — never a generic "cannot delete" that leaves
// the caller guessing what to fix.
function findDeletionBlockers(userId) {
  const blockers = [];
  if (countWhere("marketplace_assets", "creatorUserId", userId)) blockers.push("has published marketplace content");
  const purchases = db.prepare("SELECT COUNT(*) c FROM asset_purchases WHERE buyerUserId = ? OR sellerUserId = ?").get(userId, userId).c;
  if (purchases) blockers.push("has a marketplace purchase or sale on record");
  if (countWhere("custom_tools", "creatorUserId", userId)) blockers.push("has published a custom tool");
  if (countWhere("coupon_codes", "createdBy", userId)) blockers.push("has created coupon codes as a platform admin");
  if (countWhere("organization_credits", "grantedBy", userId)) blockers.push("has granted organization credits as a platform admin");
  return blockers;
}

// requestedBy: the acting user's id — the SAME id for a self-delete, or
// the admin's id for an admin-triggered delete. Used only for the audit
// log entry, logged BEFORE the delete so it survives it (see the
// per-branch comment below for why WHOSE activity_logs row it lands in
// matters).
export async function deleteUserAccount(userId, { requestedBy }) {
  const user = db.prepare("SELECT id, email, isPlatformAdmin FROM users WHERE id = ?").get(userId);
  if (!user) throw new Error("Account not found.");

  const blockers = findDeletionBlockers(userId);
  if (blockers.length) {
    throw new Error(`This account can't be deleted yet — it ${blockers.join(", and it ")}. Contact support to handle this manually.`);
  }

  // Orgs this user OWNS get deleted via the exact same, already-tested
  // function the self-service "delete my org" route already uses today
  // (routes/organizations.js DELETE /:id) — same policy this app already
  // has: the owner can delete the org outright, no member-count guard.
  // This introduces no new behavior, just reaches it from a second entry
  // point.
  const ownedOrgs = db.prepare("SELECT id FROM organizations WHERE ownerId = ?").all(userId);
  for (const { id: orgId } of ownedOrgs) {
    await deleteOrganization(orgId);
  }

  // Logged before the delete. Self-delete logs under the deleting user's
  // OWN id — it cascades away with them via activity_logs' own FK
  // (db.js), which is fine: there's no "who did this to someone else"
  // question to preserve for a self-delete. Admin-triggered delete logs
  // under the ADMIN's id instead (same pattern as admin_created_user in
  // adminUserManager.js) so the record survives the very deletion it's
  // documenting.
  logActivity(db, requestedBy, "account_deleted", `Deleted account ${user.email}${requestedBy !== userId ? " (admin action)" : ""}`, {});

  const cleanupTx = db.transaction(() => {
    db.prepare("DELETE FROM marketplace_installs WHERE installedByUserId = ?").run(userId);
    db.prepare("DELETE FROM asset_reports WHERE reporterUserId = ?").run(userId);

    // The user's own reviews — deleted directly (not via
    // marketplaceReviews.js's deleteReview(), which requires the ACTING
    // user to own the review; here the account being torn down IS that
    // user) but recomputed the same way, so no asset's cached rating
    // drifts.
    const ownReviews = db.prepare("SELECT id, assetId FROM asset_reviews WHERE userId = ?").all(userId);
    for (const { id: reviewId, assetId } of ownReviews) {
      db.prepare("DELETE FROM asset_reviews WHERE id = ?").run(reviewId);
      recomputeAssetRating(assetId);
    }

    // Helpful votes this user cast on OTHERS' reviews — no FK to enforce
    // this, so it's cleaned up manually, and the affected reviews'
    // cached helpfulCount is recomputed the same way toggleHelpfulVote()
    // already does, so removing this user's vote is reflected exactly
    // once, not left stale.
    const affectedReviewIds = db.prepare("SELECT DISTINCT reviewId FROM asset_review_votes WHERE userId = ?").all(userId).map((r) => r.reviewId);
    db.prepare("DELETE FROM asset_review_votes WHERE userId = ?").run(userId);
    for (const reviewId of affectedReviewIds) {
      const count = db.prepare("SELECT COUNT(*) c FROM asset_review_votes WHERE reviewId = ?").get(reviewId).c;
      db.prepare("UPDATE asset_reviews SET helpfulCount = ? WHERE id = ?").run(count, reviewId);
    }

    // Last — cascades every table with a real FK (28 of them; see this
    // file's header comment).
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
  cleanupTx();

  return { deleted: true, email: user.email };
}
