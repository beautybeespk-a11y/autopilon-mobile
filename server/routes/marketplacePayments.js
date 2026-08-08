import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { getAsset } from "../orchestrator/marketplace.js";
import { createAssetCheckoutSession } from "../orchestrator/stripeService.js";
import { listMyPurchases, hasPurchased } from "../orchestrator/marketplacePayments.js";

const router = Router();
router.use(requireAuth);

router.get("/my-purchases", (req, res) => res.json(listMyPurchases(req.session.userId)));

router.post("/assets/:id/purchase", async (req, res) => {
  const asset = getAsset(req.session.userId, req.params.id);
  if (!asset) return res.status(404).json({ error: "Asset not found." });
  if (asset.pricingType === "free") return res.status(400).json({ error: "This asset is free — just install it." });
  if (asset.pricingType === "subscription") return res.status(400).json({ error: "Subscription-priced assets aren't supported for purchase yet." });
  if (asset.creatorUserId === req.session.userId) return res.status(400).json({ error: "You can't buy your own asset." });
  if (hasPurchased(req.session.userId, asset.id)) return res.status(400).json({ error: "You already own this asset." });

  try {
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const url = await createAssetCheckoutSession(
      req.session.userId, asset,
      `${base}/app/marketplace/${asset.id}?purchase=success`,
      `${base}/app/marketplace/${asset.id}?purchase=canceled`
    );
    logActivity(db, req.session.userId, "marketplace_purchase_started", `Started checkout for "${asset.name}"`);
    res.json({ url });
  } catch (err) {
    res.status(err.code === "STRIPE_NOT_CONFIGURED" ? 503 : 400).json({ error: err.message });
  }
});

export default router;
