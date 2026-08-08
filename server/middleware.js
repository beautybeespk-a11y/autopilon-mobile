import db from "./db.js";

export function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
}

// Platform admin is a global flag on the user row, not tied to any
// organization — separate concept from an org's own "owner" role. There's
// no self-service way to become one; see routes/auth.js for the bootstrap.
export function requirePlatformAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = db.prepare("SELECT isPlatformAdmin FROM users WHERE id = ?").get(req.session.userId);
  if (!user?.isPlatformAdmin) return res.status(403).json({ error: "Platform admin access required." });
  next();
}

// The 5th param is optional and additive — every existing call site with
// just (db, userId, action, description) keeps logging exactly as it always
// has. Passing { orgId, workspaceId, req, result } enriches the entry with
// the context that matters for compliance/audit review; req.ip is pulled
// automatically when a request object is passed rather than making every
// caller extract it themselves.
export function logActivity(db, userId, action, description, context = {}) {
  const { orgId, workspaceId, req, result } = context;
  db.prepare(
    "INSERT INTO activity_logs (id, userId, action, description, orgId, workspaceId, ip, result, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(cryptoRandom(), userId, action, description, orgId || null, workspaceId || null, req?.ip || null, result || "success", new Date().toISOString());
}

export function cryptoRandom() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}
