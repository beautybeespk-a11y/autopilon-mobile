import crypto from "crypto";
import bcrypt from "bcryptjs";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { requireFileAccess } from "./fileService.js";
import { logFileActivity } from "./fileActivity.js";
import { publishEvent } from "../automation/triggers.js";

const now = () => new Date().toISOString();

// Share tokens ARE the access control for a public link, unlike every other
// id in this app (cryptoRandom() is fine for those — they're never secrets
// on their own, access still requires a session). This needs real entropy,
// so it uses crypto.randomBytes directly rather than the app's usual id
// generator.
function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function createShare(userId, fileId, { expiresAt, password, downloadOnly } = {}) {
  const file = requireFileAccess(userId, fileId, "share");
  const id = cryptoRandom();
  const token = generateToken();
  const ts = now();
  db.prepare(
    `INSERT INTO file_shares (id, fileId, token, createdBy, expiresAt, passwordHash, downloadOnly, revoked, accessCount, lastAccessedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?)`
  ).run(id, fileId, token, userId, expiresAt || null, password ? bcrypt.hashSync(password, 10) : null, downloadOnly ? 1 : 0, ts);
  logFileActivity(fileId, "share", { userId, orgId: file.orgId, workspaceId: file.workspaceId, detail: `Link created${expiresAt ? `, expires ${expiresAt}` : ""}` });
  publishEvent(userId, "files", "file_shared", { fileId, shareId: id });
  return db.prepare("SELECT * FROM file_shares WHERE id = ?").get(id);
}

export function listShares(userId, fileId) {
  requireFileAccess(userId, fileId, "share");
  return db.prepare("SELECT id, fileId, createdBy, expiresAt, passwordHash IS NOT NULL AS hasPassword, downloadOnly, revoked, accessCount, lastAccessedAt, createdAt FROM file_shares WHERE fileId = ? ORDER BY createdAt DESC").all(fileId)
    .map((s) => ({ ...s, hasPassword: Boolean(s.hasPassword) }));
  // token is deliberately never returned here once created — the creator
  // sees it once at creation time (createShare's return value), same
  // principle as an API key.
}

export function revokeShare(userId, fileId, shareId) {
  const file = requireFileAccess(userId, fileId, "share");
  const share = db.prepare("SELECT * FROM file_shares WHERE id = ? AND fileId = ?").get(shareId, fileId);
  if (!share) {
    const err = new Error("Share link not found.");
    err.code = "NOT_FOUND";
    throw err;
  }
  db.prepare("UPDATE file_shares SET revoked = 1 WHERE id = ?").run(shareId);
  logFileActivity(fileId, "permission_changed", { userId, orgId: file.orgId, workspaceId: file.workspaceId, detail: "Share link revoked" });
}

// Landing-page info for a share link — enough to show "this is 'report.pdf',
// 2.3MB, password-protected" WITHOUT exposing content or requiring the
// password up front, so a client can render a real page instead of a blind
// password prompt.
export function getShareInfo(token) {
  const share = db.prepare("SELECT * FROM file_shares WHERE token = ?").get(token);
  if (!share) return { valid: false, reason: "not_found" };
  if (share.revoked) return { valid: false, reason: "revoked" };
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) return { valid: false, reason: "expired" };
  const file = db.prepare("SELECT filename, mimeType, sizeBytes, extension FROM files WHERE id = ? AND status = 'active'").get(share.fileId);
  if (!file) return { valid: false, reason: "not_found" };
  return { valid: true, requiresPassword: Boolean(share.passwordHash), downloadOnly: Boolean(share.downloadOnly), file };
}

// Resolves a public token into a file — the ONE path in this whole system
// that grants file access without a logged-in session, so every failure
// mode is a distinct, specific error the route can act on (never a generic
// 403 that leaks whether the token itself was even valid).
export function resolveShare(token, { password } = {}) {
  const share = db.prepare("SELECT * FROM file_shares WHERE token = ?").get(token);
  if (!share) {
    const err = new Error("This link is invalid.");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (share.revoked) {
    const err = new Error("This link has been revoked.");
    err.code = "REVOKED";
    throw err;
  }
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
    const err = new Error("This link has expired.");
    err.code = "EXPIRED";
    throw err;
  }
  if (share.passwordHash) {
    if (!password) {
      const err = new Error("This link is password-protected.");
      err.code = "PASSWORD_REQUIRED";
      throw err;
    }
    if (!bcrypt.compareSync(password, share.passwordHash)) {
      const err = new Error("Incorrect password.");
      err.code = "WRONG_PASSWORD";
      throw err;
    }
  }
  const file = db.prepare("SELECT * FROM files WHERE id = ? AND status = 'active'").get(share.fileId);
  if (!file) {
    const err = new Error("This file is no longer available.");
    err.code = "NOT_FOUND";
    throw err;
  }
  db.prepare("UPDATE file_shares SET accessCount = accessCount + 1, lastAccessedAt = ? WHERE id = ?").run(now(), share.id);
  logFileActivity(file.id, "download", { orgId: file.orgId, workspaceId: file.workspaceId, detail: "Via share link" });
  return { file, share: { ...share, downloadOnly: Boolean(share.downloadOnly) } };
}
