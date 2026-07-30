export function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
}

export function logActivity(db, userId, action, description) {
  db.prepare(
    "INSERT INTO activity_logs (id, userId, action, description, createdAt) VALUES (?, ?, ?, ?, ?)"
  ).run(cryptoRandom(), userId, action, description, new Date().toISOString());
}

export function cryptoRandom() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}
