import { Router } from "express";
import db from "../db.js";
import { requireAuth } from "../middleware.js";
const router = Router();
router.use(requireAuth);
router.get("/", (req, res) =>
  res.json(db.prepare("SELECT * FROM activity_logs WHERE userId = ? ORDER BY createdAt DESC LIMIT 50").all(req.session.userId))
);
export default router;
