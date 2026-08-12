import db from "../db.js";
import { getSubscriptionWithPlan } from "./billing.js";

// No rollup table (see the comment in db.js) — SUM(sizeBytes) over active
// files is cheap at this app's scale and always correct, never drifts.
export function getStorageUsage({ orgId, userId }) {
  if (orgId) {
    const row = db.prepare("SELECT COALESCE(SUM(sizeBytes),0) bytes, COUNT(*) c FROM files WHERE orgId = ? AND status = 'active'").get(orgId);
    return { scope: "organization", orgId, usedBytes: row.bytes, fileCount: row.c };
  }
  const row = db.prepare("SELECT COALESCE(SUM(sizeBytes),0) bytes, COUNT(*) c FROM files WHERE ownerId = ? AND orgId IS NULL AND status = 'active'").get(userId);
  return { scope: "personal", userId, usedBytes: row.bytes, fileCount: row.c };
}

// Same "personal mode is unmetered" rule the rest of billing.js follows —
// an org-scoped upload is checked against its plan; a personal upload never
// hits a storage ceiling, same as personal chat never hits a quota today.
export function checkStorageQuota(orgId, additionalBytes = 0) {
  if (!orgId) return { allowed: true, limit: null, used: 0, remaining: null, percentUsed: 0 };
  const sub = getSubscriptionWithPlan(orgId);
  const limit = sub?.plan?.maxStorageBytes ?? null;
  const usage = getStorageUsage({ orgId });
  if (limit == null) return { allowed: true, limit: null, used: usage.usedBytes, remaining: null, percentUsed: 0 };
  const projected = usage.usedBytes + additionalBytes;
  const percentUsed = Math.min(100, Math.round((projected / limit) * 100));
  return { allowed: projected <= limit, limit, used: usage.usedBytes, remaining: Math.max(limit - usage.usedBytes, 0), percentUsed };
}

// Per-upload size cap — separate from the total-storage quota above.
// Personal (no org) uploads use the Free plan's cap as a sane default cap
// rather than being unlimited, since an unbounded single upload isn't the
// same kind of "unmetered" as ordinary usage-based quotas.
export function maxUploadBytesFor(orgId) {
  const sub = orgId ? getSubscriptionWithPlan(orgId) : null;
  const plan = sub?.plan || db.prepare("SELECT * FROM plans WHERE id = 'free'").get();
  const mb = plan?.maxFileUploadMB;
  return mb == null ? null : mb * 1024 * 1024;
}
