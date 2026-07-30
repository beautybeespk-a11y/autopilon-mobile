import { Router } from "express";
import db from "../db.js";
import { requireAuth } from "../middleware.js";
const router = Router();
router.use(requireAuth);
router.get("/", (req, res) => res.json(db.prepare("SELECT * FROM skills ORDER BY name").all()));
export default router;
