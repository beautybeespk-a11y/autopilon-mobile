import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import { listReviews, createOrUpdateReview, deleteReview, toggleHelpfulVote, replyAsDeveloper } from "../orchestrator/marketplaceReviews.js";

const router = Router();
router.use(requireAuth);

router.get("/assets/:id/reviews", (req, res) => {
  res.json(listReviews(req.params.id, { sort: req.query.sort }));
});

router.post("/assets/:id/reviews", (req, res) => {
  try {
    const result = createOrUpdateReview(req.session.userId, req.params.id, req.body || {});
    logActivity(db, req.session.userId, "marketplace_review_posted", "Posted a marketplace review");
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/reviews/:id", (req, res) => {
  try { res.json(deleteReview(req.session.userId, req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.post("/reviews/:id/helpful", (req, res) => {
  try { res.json(toggleHelpfulVote(req.session.userId, req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.post("/reviews/:id/reply", (req, res) => {
  const { reply } = req.body || {};
  if (!reply?.trim()) return res.status(400).json({ error: "reply is required." });
  try {
    const result = replyAsDeveloper(req.session.userId, req.params.id, reply);
    res.json(result);
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

export default router;
