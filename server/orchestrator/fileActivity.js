import db from "../db.js";
import { cryptoRandom } from "../middleware.js";

// The single place every file-touching code path logs through — mirrors
// logActivity() in middleware.js but scoped to files.js's own activity
// table (fileId-keyed, not user-keyed) since spec §21 wants this queryable
// per-file ("show me everything that happened to this document"), which
// the general activity_logs table isn't indexed for.
export function logFileActivity(fileId, action, { userId, orgId, workspaceId, projectId, agentId, result = "success", detail } = {}) {
  db.prepare(
    `INSERT INTO file_activity (id, fileId, userId, orgId, workspaceId, projectId, agentId, action, result, detail, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cryptoRandom(), fileId, userId || null, orgId || null, workspaceId || null, projectId || null, agentId || null, action, result, detail || null, new Date().toISOString());
}

export function listFileActivity(fileId, limit = 50) {
  return db.prepare("SELECT * FROM file_activity WHERE fileId = ? ORDER BY createdAt DESC LIMIT ?").all(fileId, limit);
}
