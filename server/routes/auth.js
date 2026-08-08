import { Router } from "express";
import bcrypt from "bcryptjs";
import db from "../db.js";
import { cryptoRandom, logActivity } from "../middleware.js";

const router = Router();

router.post("/signup", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: "An account with this email already exists." });

  const id = cryptoRandom();
  const hash = bcrypt.hashSync(password, 10);
  const isPlatformAdmin = process.env.PLATFORM_ADMIN_EMAIL && email.toLowerCase() === process.env.PLATFORM_ADMIN_EMAIL.toLowerCase() ? 1 : 0;
  db.prepare("INSERT INTO users (id, name, email, password, isPlatformAdmin, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, email.toLowerCase(), hash, isPlatformAdmin, new Date().toISOString());
  req.session.userId = id;
  res.json({ user: { id, name, email: email.toLowerCase() } });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password)) {
    if (user) logActivity(db, user.id, "login_failed", "Failed login attempt", { req, result: "failure" });
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  req.session.userId = user.id;
  if (process.env.PLATFORM_ADMIN_EMAIL && user.email.toLowerCase() === process.env.PLATFORM_ADMIN_EMAIL.toLowerCase() && !user.isPlatformAdmin) {
    db.prepare("UPDATE users SET isPlatformAdmin = 1 WHERE id = ?").run(user.id);
  }
  logActivity(db, user.id, "login", "Logged in", { req });
  res.json({ user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar } });
});

router.post("/logout", (req, res) => {
  const userId = req.session?.userId;
  if (userId) logActivity(db, userId, "logout", "Logged out", { req });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = db.prepare("SELECT id, name, email, avatar, isPlatformAdmin FROM users WHERE id = ?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ user: { ...user, isPlatformAdmin: Boolean(user.isPlatformAdmin) } });
});

// Phase 1: no email delivery yet. Endpoint acknowledges without leaking which
// emails exist, so the flow can be wired to a mailer later.
router.post("/forgot-password", (req, res) => {
  res.json({ ok: true, message: "If an account exists for that email, reset instructions will be sent." });
});

export default router;
