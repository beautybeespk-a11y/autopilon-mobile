import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createNotification } from "./notifications.js";

const now = () => new Date().toISOString();

// Resolves @name or @email fragments in a comment against people the
// author actually shares an active organization with — mentioning someone
// outside any shared org context silently doesn't match anyone, rather
// than exposing the whole platform's user directory to a mention parser.
function resolveMentions(authorUserId, content) {
  const fragments = Array.from(content.matchAll(/@([\w.+-]+@[\w.-]+\.\w+|[\w.-]{2,})/g)).map((m) => m[1]);
  if (!fragments.length) return [];
  const orgIds = db.prepare("SELECT orgId FROM organization_members WHERE userId = ? AND status = 'active'").all(authorUserId).map((r) => r.orgId);
  if (!orgIds.length) return [];
  const candidates = db.prepare(
    `SELECT DISTINCT u.id, u.name, u.email FROM users u
     JOIN organization_members om ON om.userId = u.id
     WHERE om.orgId IN (${orgIds.map(() => "?").join(",")}) AND om.status = 'active'`
  ).all(...orgIds);

  const matched = new Set();
  for (const frag of fragments) {
    const lower = frag.toLowerCase();
    const hit = candidates.find((c) => c.email.toLowerCase() === lower || c.name.toLowerCase().replace(/\s+/g, "") === lower.replace(/\s+/g, ""));
    if (hit && hit.id !== authorUserId) matched.add(hit.id);
  }
  return Array.from(matched);
}

export function createComment(authorUserId, { entityType, entityId, content }) {
  if (!content?.trim()) throw new Error("Comment content is required.");
  const mentionedUserIds = resolveMentions(authorUserId, content);
  const id = cryptoRandom();
  db.prepare(
    "INSERT INTO comments (id, entityType, entityId, authorUserId, content, mentionedUserIds, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, entityType, entityId, authorUserId, content, JSON.stringify(mentionedUserIds), now());

  const author = db.prepare("SELECT name FROM users WHERE id = ?").get(authorUserId);
  for (const mentionedId of mentionedUserIds) {
    createNotification(mentionedId, {
      type: "mention",
      title: `${author?.name || "Someone"} mentioned you`,
      body: content.slice(0, 140),
      link: `/app/${entityType}s`, // best-effort — most entity list pages live at /app/<type>s
    });
  }
  return { id, mentionedUserIds };
}

export function listComments(entityType, entityId) {
  return db.prepare(
    `SELECT c.*, u.name AS authorName, u.avatar AS authorAvatar FROM comments c
     JOIN users u ON u.id = c.authorUserId
     WHERE c.entityType = ? AND c.entityId = ? ORDER BY c.createdAt ASC`
  ).all(entityType, entityId).map((c) => ({ ...c, mentionedUserIds: JSON.parse(c.mentionedUserIds || "[]") }));
}

export function deleteComment(userId, commentId) {
  const comment = db.prepare("SELECT authorUserId FROM comments WHERE id = ?").get(commentId);
  if (!comment || comment.authorUserId !== userId) throw new Error("Comment not found.");
  db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
  return { deleted: true };
}
