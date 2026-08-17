#!/usr/bin/env node
// Real, tested SQLite restore (Phase 18 §6/§39) — the counterpart to
// backup-db.js. Verifies the backup BEFORE touching the live database,
// takes a safety copy of whatever is currently live before overwriting it
// (so a bad restore is itself reversible), and re-verifies after.
//
// Usage:
//   node scripts/restore-db.js <backupFile> [--target <dbPath>] [--force]
//
// Refuses to overwrite an existing target database unless --force is
// passed — this is a deliberately destructive operation on production
// data and should never run by accident or as a side effect of some other
// script.
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { logger } from "../config/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const args = { backupFile: null, target: null, force: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") args.target = argv[++i];
    else if (argv[i] === "--force") args.force = true;
    else positional.push(argv[i]);
  }
  args.backupFile = positional[0] || null;
  return args;
}

async function decompressIfNeeded(backupFile) {
  if (!backupFile.endsWith(".gz")) return backupFile;
  const decompressedPath = backupFile.replace(/\.gz$/, "");
  await pipeline(fs.createReadStream(backupFile), zlib.createGunzip(), fs.createWriteStream(decompressedPath));
  return decompressedPath;
}

export async function restoreDatabase({ backupFile, target, force = false } = {}) {
  if (!backupFile) throw new Error("backupFile is required");
  if (!fs.existsSync(backupFile)) throw new Error(`Backup file not found: ${backupFile}`);

  const targetPath = target || process.env.DB_PATH || join(SERVER_ROOT, "app.sqlite");
  const start = Date.now();

  const usableBackupPath = await decompressIfNeeded(backupFile);

  // Verify the backup BEFORE touching anything live.
  const verifyDb = new Database(usableBackupPath, { readonly: true, fileMustExist: true });
  const integrityResult = verifyDb.pragma("integrity_check", { simple: true });
  const preRestoreRowCounts = {};
  for (const table of ["users", "organizations", "agents", "jobs"]) {
    try {
      preRestoreRowCounts[table] = verifyDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    } catch {
      // table doesn't exist in this backup — fine, not every backup has every table
    }
  }
  verifyDb.close();
  if (integrityResult !== "ok") {
    throw new Error(`Refusing to restore: backup failed integrity_check (${integrityResult})`);
  }

  const targetExists = fs.existsSync(targetPath);
  if (targetExists && !force) {
    throw new Error(`Target database already exists at ${targetPath} — pass --force to overwrite it (a safety copy of the current file will be made first).`);
  }

  let safetyCopyPath = null;
  if (targetExists) {
    safetyCopyPath = `${targetPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(targetPath, safetyCopyPath);
  }

  fs.copyFileSync(usableBackupPath, targetPath);
  // The restored file is a complete, checkpointed snapshot — any leftover
  // -wal/-shm sidecar files from whatever was previously at targetPath
  // reference the OLD file's state and must not be reused against it.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = targetPath + suffix;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }

  // Re-verify against the now-live file.
  const postDb = new Database(targetPath, { readonly: true, fileMustExist: true });
  const postIntegrity = postDb.pragma("integrity_check", { simple: true });
  const postRestoreRowCounts = {};
  for (const table of ["users", "organizations", "agents", "jobs"]) {
    try {
      postRestoreRowCounts[table] = postDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    } catch {
      // fine — see above
    }
  }
  postDb.close();
  if (postIntegrity !== "ok") {
    throw new Error(`Restore completed but post-restore integrity_check failed (${postIntegrity}) — the file at ${targetPath} may be corrupt.`);
  }

  const restoreDurationMs = Date.now() - start;
  const result = {
    ok: true,
    backupFile,
    targetPath,
    safetyCopyPath,
    restoreDurationMs,
    preRestoreRowCounts,
    postRestoreRowCounts,
  };
  logger.info("restore.completed", result);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.backupFile) {
    console.error("Usage: node scripts/restore-db.js <backupFile> [--target <dbPath>] [--force]");
    process.exit(1);
  }
  restoreDatabase(args)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Restore failed:", err.message);
      process.exit(1);
    });
}
