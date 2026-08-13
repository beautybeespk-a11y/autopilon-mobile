// Controlled maintenance mode (Phase 16 §35) — a single row in the generic
// platform_settings key-value table, not a new bespoke table, since this is
// exactly one small piece of global config. Deliberately does NOT touch the
// job/queue processors at all: an in-flight background job keeps running
// regardless of maintenance mode, since this only gates NEW incoming HTTP
// requests (see the maintenanceGate middleware in index.js) — that's what
// "graceful handling of active jobs" means here: don't abruptly kill them,
// which is trivially satisfied by never touching them in the first place.
import db from "../db.js";

const SETTINGS_KEY = "maintenance_mode";

function readSettings() {
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(SETTINGS_KEY);
  return row ? JSON.parse(row.value) : { enabled: false, message: "", readOnly: false, updatedAt: null };
}

export function maintenanceStatus() {
  return readSettings();
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
  return next;
}
