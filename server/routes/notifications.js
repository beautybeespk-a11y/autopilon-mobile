import { Router } from "express";
import { requireAuth } from "../middleware.js";
import { listNotifications, unreadCount, markRead, markAllRead } from "../orchestrator/notifications.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json({ notifications: listNotifications(req.session.userId, { unreadOnly: req.query.unread === "true" }), unreadCount: unreadCount(req.session.userId) });
});

router.post("/:id/read", (req, res) => res.json(markRead(req.session.userId, req.params.id)));
router.post("/read-all", (req, res) => res.json(markAllRead(req.session.userId)));

export default router;
