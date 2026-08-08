import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { ensureSubscription, getPlan } from "./billing.js";
import { createNotification } from "./notifications.js";

const now = () => new Date().toISOString();

export function createCoupon(createdBy, { code, type, value, targetPlanId, maxRedemptions, expiresAt }) {
  if (!code?.trim()) throw new Error("Coupon code is required.");
  if (!["trial", "percent_discount", "fixed_discount"].includes(type)) throw new Error("type must be 'trial', 'percent_discount', or 'fixed_discount'.");
  if (type === "trial" && targetPlanId && !getPlan(targetPlanId)) throw new Error(`Unknown plan "${targetPlanId}".`);
  const id = cryptoRandom();
  db.prepare(
    `INSERT INTO coupon_codes (id, code, type, value, targetPlanId, maxRedemptions, expiresAt, active, createdBy, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, code.toUpperCase(), type, value, targetPlanId || null, maxRedemptions ?? null, expiresAt || null, createdBy, now());
  return db.prepare("SELECT * FROM coupon_codes WHERE id = ?").get(id);
}

export function listCoupons() {
  return db.prepare("SELECT * FROM coupon_codes ORDER BY createdAt DESC").all();
}

export function setCouponActive(couponId, active) {
  db.prepare("UPDATE coupon_codes SET active = ? WHERE id = ?").run(active ? 1 : 0, couponId);
  return { active };
}

function validateCoupon(code, orgId) {
  const coupon = db.prepare("SELECT * FROM coupon_codes WHERE code = ?").get(code.toUpperCase());
  if (!coupon) throw new Error("Invalid coupon code.");
  if (!coupon.active) throw new Error("This coupon is no longer active.");
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) throw new Error("This coupon has expired.");
  if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) throw new Error("This coupon has reached its redemption limit.");
  const already = db.prepare("SELECT id FROM coupon_redemptions WHERE couponId = ? AND orgId = ?").get(coupon.id, orgId);
  if (already) throw new Error("Your organization has already redeemed this coupon.");
  return coupon;
}

// Trial coupons apply immediately (there's no payment step to gate on).
// Discount coupons are recorded as redeemed and their effect is deferred —
// there's no real charge to discount until Stripe checkout exists; the
// redemption row is what that future checkout flow will look up.
export function redeemCoupon(orgId, code) {
  const coupon = validateCoupon(code, orgId);
  const sub = ensureSubscription(orgId);

  if (coupon.type === "trial") {
    const planId = coupon.targetPlanId || sub.planId;
    const trialEndsAt = new Date(Date.now() + coupon.value * 86400_000).toISOString();
    db.prepare("UPDATE subscriptions SET planId = ?, status = 'trialing', trialEndsAt = ?, updatedAt = ? WHERE orgId = ?")
      .run(planId, trialEndsAt, now(), orgId);
  }

  db.prepare("INSERT INTO coupon_redemptions (id, couponId, orgId, redeemedAt) VALUES (?, ?, ?, ?)").run(cryptoRandom(), coupon.id, orgId, now());
  db.prepare("UPDATE coupon_codes SET redemptionCount = redemptionCount + 1 WHERE id = ?").run(coupon.id);

  return { couponId: coupon.id, type: coupon.type, value: coupon.value, applied: coupon.type === "trial" };
}

// Periodic sweep (wired into index.js alongside the existing confirmation
// expiry sweep) — finds trials that have run out and reverts them to the
// Free plan, notifying the org owner.
export function sweepExpiredTrials() {
  const expired = db.prepare("SELECT * FROM subscriptions WHERE status = 'trialing' AND trialEndsAt < ?").all(now());
  for (const sub of expired) {
    db.prepare("UPDATE subscriptions SET planId = 'free', status = 'active', trialEndsAt = NULL, updatedAt = ? WHERE id = ?").run(now(), sub.id);
    const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(sub.orgId);
    if (org) {
      createNotification(org.ownerId, {
        type: "trial_ended",
        title: `Your trial for "${org.name}" has ended`,
        body: "You've been moved back to the Free plan.",
        link: `/app/organizations/${sub.orgId}`,
      });
    }
  }
  return expired.length;
}
