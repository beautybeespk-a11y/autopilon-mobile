import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createNotification } from "./notifications.js";
import { canAccessAgent } from "./agentManager.js";
import { canAccessProject } from "./projectManager.js";
import { canAccessFile } from "./filePermissions.js";
import { canAccessContent } from "./contentPermissions.js";

const now = () => new Date().toISOString();

// This comments feature is generic across entity types by design (any
// resource can grow a comment thread later), but that genericity was the
// bug: neither createComment() nor listComments() checked whether the
// caller could actually access the (entityType, entityId) they were
// commenting on — any authenticated user could read and write comments on
// ANY entity in the system regardless of ownership or org membership.
// Fixed alongside a Phase 16 security audit by requiring every entity type
// to resolve through its OWN existing permission check before a comment
// read/write is allowed; an entityType with no entry here is denied by
// default rather than allowed by default.
const ENTITY_ACCESS = {
  task: (userId, id) => Boolean(db.prepare("SELECT 1 FROM tasks WHERE id = ? AND userId = ?").get(id, userId)),
  agent: (userId, id) => canAccessAgent(userId, db.prepare("SELECT * FROM agents WHERE id = ?").get(id)),
  project: (userId, id) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return Boolean(project) && canAccessProject(userId, project);
  },
  file: (userId, id) => canAccessFile(userId, db.prepare("SELECT * FROM files WHERE id = ?").get(id), "view"),
  content: (userId, id) => canAccessContent(userId, db.prepare("SELECT * FROM content_assets WHERE id = ?").get(id), "view"),
};

export function canAccessEntity(userId, entityType, entityId) {
  const check = ENTITY_ACCESS[entityType];
  return Boolean(check && check(userId, entityId));
}

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

  // Round 33 sweep finding: this used a single find() combining an exact
  // email match with a normalized-name match, with no check for whether
  // 2+ candidates matched by name. Email is safe unguarded — it's UNIQUE
  // per user (users.email has a UNIQUE constraint, db.js) so it can never
  // match more than one candidate. Name is not: two org members can share
  // a display name, and find() silently returned whichever came first in
  // SQL result order — notifying/mentioning the wrong person with no
  // indication anything was ambiguous. Same "2+ matches -> don't guess"
  // discipline matchCreativeCandidateId already has (orchestrator/index.js).
  const matched = new Set();
  for (const frag of fragments) {
    const lower = frag.toLowerCase();
    const emailHit = candidates.find((c) => c.email.toLowerCase() === lower);
    if (emailHit) {
      if (emailHit.id !== authorUserId) matched.add(emailHit.id);
      continue;
    }
    const normalizedFrag = lower.replace(/\s+/g, "");
    const nameHits = candidates.filter((c) => c.name.toLowerCase().replace(/\s+/g, "") === normalizedFrag);
    if (nameHits.length === 1 && nameHits[0].id !== authorUserId) matched.add(nameHits[0].id);
    // nameHits.length > 1: genuinely ambiguous — this fragment resolves
    // to no one rather than guessing which "John Smith" was meant.
  }
  return Array.from(matched);
}

function requireEntityAccess(userId, entityType, entityId) {
  if (!canAccessEntity(userId, entityType, entityId)) {
    const err = new Error("You don't have permission to access this.");
    err.code = "FORBIDDEN";
    throw err;
  }
}

export function createComment(authorUserId, { entityType, entityId, content }) {
  requireEntityAccess(authorUserId, entityType, entityId);
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

export function listComments(userId, entityType, entityId) {
  requireEntityAccess(userId, entityType, entityId);
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
