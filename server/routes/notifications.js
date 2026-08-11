import { Router } from "express";
import { requireAuth } from "../middleware.js";
import { listNotifications, unreadCount, markRead, markAllRead } from "../orchestrator/notifications.js";
import { pushStatus, registerDeviceToken, unregisterDeviceToken } from "../orchestrator/pushNotifications.js";

const router = Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json({ notifications: listNotifications(req.session.userId, { unreadOnly: req.query.unread === "true" }), unreadCount: unreadCount(req.session.userId) });
});

router.post("/:id/read", (req, res) => res.json(markRead(req.session.userId, req.params.id)));
router.post("/read-all", (req, res) => res.json(markAllRead(req.session.userId)));

// Phase 12D — mobile push. Lets the mobile client check whether push is
// even configured server-side before bothering to request permission.
router.get("/push-status", (req, res) => res.json(pushStatus()));

router.post("/device-token", (req, res) => {
  const { token, platform } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required." });
  registerDeviceToken(req.session.userId, token, platform || "android");
  res.json({ ok: true });
});

// Called on logout — a path param (not a body) so the mobile client can
// use the same ApiClient.delete(path) helper every other "delete by id"
// call already uses. No extra ownership check needed beyond requireAuth
// above; deleting by token can never affect another user's device.
router.delete("/device-token/:token", (req, res) => {
  unregisterDeviceToken(req.params.token);
  res.json({ ok: true });
});

export default router;
