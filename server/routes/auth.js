import { Router } from "express";
import bcrypt from "bcryptjs";
import db from "../db.js";
import { cryptoRandom, logActivity } from "../middleware.js";
import { rateLimit } from "../orchestrator/rateLimiter.js";

const router = Router();

// Credential-stuffing / brute-force protection — tighter than the general
// API rate limit, and keyed by IP since there's no session yet at this point.
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.ip, label: "auth" });

router.post("/signup", authLimiter, (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  // Closed-beta / pre-launch switch — unset (default) means signup stays
  // open, same as before this existed. The platform admin's own email is
  // always exempt, so PLATFORM_ADMIN_EMAIL can still bootstrap an admin
  // account on a fresh install even with this set to "false".
  const isPlatformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL && email.toLowerCase() === process.env.PLATFORM_ADMIN_EMAIL.toLowerCase();
  if (process.env.PUBLIC_SIGNUP_ENABLED === "false" && !isPlatformAdminEmail) {
    return res.status(403).json({ error: "Public signup is currently disabled. Contact the administrator for access." });
  }
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: "An account with this email already exists." });

  const id = cryptoRandom();
  const hash = bcrypt.hashSync(password, 10);
  const isPlatformAdmin = process.env.PLATFORM_ADMIN_EMAIL && email.toLowerCase() === process.env.PLATFORM_ADMIN_EMAIL.toLowerCase() ? 1 : 0;
  db.prepare("INSERT INTO users (id, name, email, password, isPlatformAdmin, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, email.toLowerCase(), hash, isPlatformAdmin, new Date().toISOString());
  req.session.userId = id;
  res.json({ user: { id, name, email: email.toLowerCase(), avatar: null, isPlatformAdmin: Boolean(isPlatformAdmin), onboardingCompleted: false } });
});

router.post("/login", authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password)) {
    if (user) logActivity(db, user.id, "login_failed", "Failed login attempt", { req, result: "failure" });
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  req.session.userId = user.id;
  let isPlatformAdmin = Boolean(user.isPlatformAdmin);
  if (process.env.PLATFORM_ADMIN_EMAIL && user.email.toLowerCase() === process.env.PLATFORM_ADMIN_EMAIL.toLowerCase() && !isPlatformAdmin) {
    db.prepare("UPDATE users SET isPlatformAdmin = 1 WHERE id = ?").run(user.id);
    isPlatformAdmin = true;
  }
  logActivity(db, user.id, "login", "Logged in", { req });
  res.json({ user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, isPlatformAdmin, onboardingCompleted: Boolean(user.onboardingCompletedAt) } });
});

router.post("/logout", (req, res) => {
  const userId = req.session?.userId;
  if (userId) logActivity(db, userId, "logout", "Logged out", { req });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = db.prepare("SELECT id, name, email, avatar, isPlatformAdmin, onboardingCompletedAt FROM users WHERE id = ?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const { onboardingCompletedAt, ...rest } = user;
  res.json({ user: { ...rest, isPlatformAdmin: Boolean(user.isPlatformAdmin), onboardingCompleted: Boolean(onboardingCompletedAt) } });
});

// Phase 1: no email delivery yet. Endpoint acknowledges without leaking which
// emails exist, so the flow can be wired to a mailer later.
router.post("/forgot-password", authLimiter, (req, res) => {
  res.json({ ok: true, message: "If an account exists for that email, reset instructions will be sent." });
});

export default router;
