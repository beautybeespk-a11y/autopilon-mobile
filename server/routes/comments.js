import { Router } from "express";
import { requireAuth } from "../middleware.js";
import { createComment, listComments, deleteComment } from "../orchestrator/comments.js";

const router = Router();
router.use(requireAuth);

router.get("/:entityType/:entityId/comments", (req, res) => {
  try {
    res.json(listComments(req.session.userId, req.params.entityType, req.params.entityId));
  } catch (err) {
    res.status(err.code === "FORBIDDEN" ? 403 : 400).json({ error: err.message });
  }
});

router.post("/:entityType/:entityId/comments", (req, res) => {
  try {
    const result = createComment(req.session.userId, { entityType: req.params.entityType, entityId: req.params.entityId, content: req.body?.content });
    res.json(result);
  } catch (err) {
    res.status(err.code === "FORBIDDEN" ? 403 : 400).json({ error: err.message });
  }
});

router.delete("/comments/:id", (req, res) => {
  try { res.json(deleteComment(req.session.userId, req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

export default router;
