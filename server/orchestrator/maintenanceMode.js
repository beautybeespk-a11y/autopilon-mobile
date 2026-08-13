// Controlled maintenance mode (Phase 16 §35) — a single row in the generic
// platform_settings key-value table, not a new bespoke table, since this is
// exactly one small piece of global config. Deliberately does NOT touch the
// job/queue processors at all: an in-flight background job keeps running
// regardless of maintenance mode, since this only gates NEW incoming HTTP
// requests (see the maintenanceGate middleware in index.js) — that's what
// "graceful handling of active jobs" means here: don't abruptly kill them,
// which is trivially satisfied by never touching them in the first place.
import db from "../db.js";
import { cached, invalidate } from "./cacheProvider.js";

const SETTINGS_KEY = "maintenance_mode";
const CACHE_KEY = "maintenance_status";

function readSettings() {
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(SETTINGS_KEY);
  return row ? JSON.parse(row.value) : { enabled: false, message: "", readOnly: false, updatedAt: null };
}

// Checked on EVERY incoming request (the maintenanceGate middleware in
// index.js), for a value an admin changes maybe a few times a year — the
// single highest-value cache target in the app. 5s TTL: enabling
// maintenance mode should take effect almost immediately across the small
// window where a request could still slip through, and setMaintenanceMode()
// invalidates this explicitly anyway on every write.
export function maintenanceStatus() {
  return cached(CACHE_KEY, 5, readSettings);
}

export function setMaintenanceMode({ enabled, message, readOnly }) {
  const current = readSettings();
  const next = {
    enabled: enabled !== undefined ? Boolean(enabled) : current.enabled,
    message: message !== undefined ? message : current.message,
    readOnly: readOnly !== undefined ? Boolean(readOnly) : current.readOnly,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO platform_settings (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`
  ).run(SETTINGS_KEY, JSON.stringify(next), next.updatedAt);
  invalidate(CACHE_KEY);
  return next;
}
