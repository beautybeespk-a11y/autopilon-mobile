import { Router } from "express";
import db from "../db.js";
import { requireAuth, requirePlatformAdmin, logActivity } from "../middleware.js";
import { getMembership } from "../orchestrator/rbac.js";
import { createCoupon, listCoupons, setCouponActive, redeemCoupon } from "../orchestrator/coupons.js";

const router = Router();
router.use(requireAuth);

// --- Platform-admin management ---
router.get("/admin/coupons", requirePlatformAdmin, (req, res) => {
  res.json(listCoupons());
});

router.post("/admin/coupons", requirePlatformAdmin, (req, res) => {
  try {
    const coupon = createCoupon(req.session.userId, req.body || {});
    logActivity(db, req.session.userId, "coupon_created", `Created coupon "${coupon.code}"`, { req });
    res.json(coupon);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/admin/coupons/:id/deactivate", requirePlatformAdmin, (req, res) => {
  res.json(setCouponActive(req.params.id, false));
});

// --- Org-side redemption ---
router.post("/organizations/:orgId/coupons/redeem", (req, res) => {
  const membership = getMembership(req.params.orgId, req.session.userId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return res.status(403).json({ error: "Only an organization owner or admin can redeem coupons." });
  }
  try {
    const result = redeemCoupon(req.params.orgId, req.body?.code || "");
    logActivity(db, req.session.userId, "coupon_redeemed", `Redeemed coupon "${req.body?.code}"`, { orgId: req.params.orgId, req });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
