// Public Marketplace browse (Phase 17 §41). Reuses orchestrator/marketplace.js's
// existing listAssets() AS-IS with viewerUserId=null, so its default clause
// — published + moderation-approved + not-private — is the ONLY thing this
// can ever return; there is no path here to see a private/draft asset,
// even the API key creator's own. "Skills" and "templates" aren't
// separately browsable because they aren't marketplace-listed entities in
// the existing system — the real marketplace covers agent/automation/
// prompt/knowledge_pack, exposed here exactly as-is, not expanded.
//
// No cursor pagination here, deliberately: listAssets() sorts by
// popularity/rating/recency, none of which are a stable, unique, monotonic
// key the shared cursor scheme (pagination.js) requires — a plain capped
// limit is the honest fit for this one endpoint, not a retrofit.
import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { apiRateLimit } from "./rateLimit.js";
import { listAssets, listCategories } from "../orchestrator/marketplace.js";

const router = Router();
router.use(requireApiKey, apiRateLimit());

router.get("/assets", requireScope("marketplace:read"), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const data = listAssets(null, {
    query: req.query.q, assetType: req.query.assetType, categoryId: req.query.categoryId, sort: req.query.sort, limit,
  });
  res.json({ data, pagination: { limit } });
});

router.get("/categories", requireScope("marketplace:read"), (req, res) => {
  res.json({ data: listCategories() });
});

export default router;
