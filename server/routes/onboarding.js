import { Router } from "express";
import db from "../db.js";
import { requireAuth } from "../middleware.js";

const router = Router();
router.use(requireAuth);

// Phase 21 — first-run onboarding state. Deliberately just one nullable
// timestamp on users, not a separate multi-step-progress table: the guided
// flow itself is client-driven (see OnboardingFlow.jsx), this is only
// "has this user ever finished/skipped it."
router.get("/status", (req, res) => {
  const row = db.prepare("SELECT onboardingCompletedAt FROM users WHERE id = ?").get(req.session.userId);
  res.json({ completed: Boolean(row?.onboardingCompletedAt) });
});

router.post("/complete", (req, res) => {
  db.prepare("UPDATE users SET onboardingCompletedAt = ? WHERE id = ?").run(new Date().toISOString(), req.session.userId);
  res.json({ ok: true });
});

export default router;
