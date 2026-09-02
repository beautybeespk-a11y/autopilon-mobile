import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createNotification } from "./notifications.js";

const now = () => new Date().toISOString();

// Exported for reuse by accountDeletion.js, which deletes a departing
// user's own reviews directly (not via deleteReview(), since that
// requires the acting user to own the review — here the caller IS the
// account being deleted) but still needs the exact same recompute so the
// asset's cached rating never drifts.
export function recomputeAssetRating(assetId) {
  const agg = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(rating), 0) s FROM asset_reviews WHERE assetId = ?").get(assetId);
  db.prepare("UPDATE marketplace_assets SET ratingCount = ?, ratingSum = ? WHERE id = ?").run(agg.c, agg.s, assetId);
}

function isVerifiedInstall(assetId, userId) {
  return Boolean(db.prepare("SELECT 1 FROM marketplace_installs WHERE assetId = ? AND installedByUserId = ?").get(assetId, userId));
}

export function listReviews(assetId, { sort = "helpful" } = {}) {
  const orderBy = sort === "recent" ? "ar.createdAt DESC" : "ar.helpfulCount DESC, ar.createdAt DESC";
  const rows = db.prepare(
    `SELECT ar.*, u.name AS userName, u.avatar AS userAvatar FROM asset_reviews ar
     JOIN users u ON u.id = ar.userId
     WHERE ar.assetId = ? ORDER BY ${orderBy}`
  ).all(assetId);
  return rows.map((r) => ({ ...r, verifiedInstall: isVerifiedInstall(assetId, r.userId) }));
}

// Upsert — reviewing again edits the existing review rather than creating
// a second one, matching the one-review-per-person UNIQUE constraint.
export function createOrUpdateReview(userId, assetId, { rating, reviewText }) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("Rating must be a whole number from 1 to 5.");
  const asset = db.prepare("SELECT id, creatorUserId, name FROM marketplace_assets WHERE id = ?").get(assetId);
  if (!asset) throw new Error("Asset not found.");
  if (asset.creatorUserId === userId) throw new Error("You can't review your own asset.");

  const existing = db.prepare("SELECT id FROM asset_reviews WHERE assetId = ? AND userId = ?").get(assetId, userId);
  const ts = now();
  if (existing) {
    db.prepare("UPDATE asset_reviews SET rating = ?, reviewText = ?, updatedAt = ? WHERE id = ?").run(rating, reviewText || null, ts, existing.id);
  } else {
    db.prepare("INSERT INTO asset_reviews (id, assetId, userId, rating, reviewText, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(cryptoRandom(), assetId, userId, rating, reviewText || null, ts, ts);
    const reviewer = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
    createNotification(asset.creatorUserId, {
      type: "new_review",
      title: `New ${rating}★ review on "${asset.name}"`,
      body: reviewText ? reviewText.slice(0, 140) : `${reviewer?.name || "Someone"} rated your asset ${rating} stars.`,
      link: `/app/marketplace/${assetId}`,
    });
  }
  recomputeAssetRating(assetId);
  return { updated: true };
}

export function deleteReview(userId, reviewId) {
  const review = db.prepare("SELECT assetId FROM asset_reviews WHERE id = ? AND userId = ?").get(reviewId, userId);
  if (!review) throw new Error("Review not found, or it isn't yours.");
  db.prepare("DELETE FROM asset_reviews WHERE id = ?").run(reviewId);
  recomputeAssetRating(review.assetId);
  return { deleted: true };
}

// Toggle — voting again removes your vote rather than stacking, so a
// person can't inflate a review's count by repeat-clicking.
export function toggleHelpfulVote(userId, reviewId) {
  const review = db.prepare("SELECT id FROM asset_reviews WHERE id = ?").get(reviewId);
  if (!review) throw new Error("Review not found.");
  const existing = db.prepare("SELECT 1 FROM asset_review_votes WHERE reviewId = ? AND userId = ?").get(reviewId, userId);
  if (existing) {
    db.prepare("DELETE FROM asset_review_votes WHERE reviewId = ? AND userId = ?").run(reviewId, userId);
  } else {
    db.prepare("INSERT INTO asset_review_votes (reviewId, userId, createdAt) VALUES (?, ?, ?)").run(reviewId, userId, now());
  }
  const count = db.prepare("SELECT COUNT(*) c FROM asset_review_votes WHERE reviewId = ?").get(reviewId).c;
  db.prepare("UPDATE asset_reviews SET helpfulCount = ? WHERE id = ?").run(count, reviewId);
  return { helpfulCount: count, voted: !existing };
}

// Only the asset's own creator can reply, and only once per review (a
// second call edits the existing reply rather than appending another).
export function replyAsDeveloper(userId, reviewId, replyText) {
  const review = db.prepare(
    "SELECT ar.id, ar.userId AS reviewerUserId, ar.assetId, ma.creatorUserId, ma.name AS assetName FROM asset_reviews ar JOIN marketplace_assets ma ON ma.id = ar.assetId WHERE ar.id = ?"
  ).get(reviewId);
  if (!review) throw new Error("Review not found.");
  if (review.creatorUserId !== userId) throw new Error("Only the asset's creator can reply to reviews.");
  db.prepare("UPDATE asset_reviews SET developerReply = ?, developerReplyAt = ? WHERE id = ?").run(replyText, now(), reviewId);
  createNotification(review.reviewerUserId, {
    type: "review_reply",
    title: `The creator replied to your review of "${review.assetName}"`,
    body: replyText.slice(0, 140),
    link: `/app/marketplace/${review.assetId}`,
  });
  return { replied: true };
}
