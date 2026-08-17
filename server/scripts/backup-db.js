#!/usr/bin/env node
// Real, tested SQLite backup (Phase 18 §6/§39) — uses better-sqlite3's
// native online backup API (SQLite's own Backup API under the hood: safe
// to run against a live, open database in WAL mode, produces a consistent
// point-in-time snapshot without blocking writers for more than brief
// individual page-copy steps). Not a file copy of app.sqlite itself, which
// would risk capturing a half-written WAL-mode file.
//
// Usage:
//   node scripts/backup-db.js [--out <dir>] [--compress]
//
// Env:
//   DB_PATH        Source database file (default: <server>/app.sqlite)
//   BACKUP_DIR     Output directory (default: <server>/backups)
//   BACKUP_COMPRESS  "true" to gzip the backup file (same as --compress)
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";
import fs from "fs";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { logger } from "../config/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const args = { out: null, compress: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--compress") args.compress = true;
  }
  return args;
}

// A handful of representative tables to sanity-check row counts against
// the source right after the backup completes — catches a truncated or
// corrupt backup file immediately, rather than the next time someone
// actually needs to restore it (which is the worst possible time to find
// out a backup was silently broken).
const SANITY_CHECK_TABLES = ["users", "organizations", "agents", "jobs"];

export async function backupDatabase({ dbPath, outDir, compress } = {}) {
  const sourcePath = dbPath || process.env.DB_PATH || join(SERVER_ROOT, "app.sqlite");
  const outputDir = outDir || process.env.BACKUP_DIR || join(SERVER_ROOT, "backups");
  const shouldCompress = compress ?? (process.env.BACKUP_COMPRESS === "true");

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFilename = `backup-${timestamp}.sqlite`;
  const backupPath = join(outputDir, backupFilename);

  const start = Date.now();
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let progressInfo = null;
  try {
    progressInfo = await source.backup(backupPath, {
      progress: ({ totalPages, remainingPages }) => {
        logger.debug("backup.progress", { totalPages, remainingPages });
        return 100; // pages transferred per step — SQLite's own recommended default-ish batch size
      },
    });
  } finally {
    source.close();
  }
  const backupDurationMs = Date.now() - start;

  // Verify immediately: open the fresh backup file, run PRAGMA
  // integrity_check, and compare row counts against the source for a few
  // key tables. A backup that fails this check is worse than no backup —
  // it creates false confidence — so this throws rather than warns.
  const verifyStart = Date.now();
  const sourceForVerify = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const backupForVerify = new Database(backupPath, { readonly: true, fileMustExist: true });
  const integrityResult = backupForVerify.pragma("integrity_check", { simple: true });
  if (integrityResult !== "ok") {
    sourceForVerify.close();
    backupForVerify.close();
    throw new Error(`Backup failed integrity_check: ${integrityResult}`);
  }
  const rowCounts = {};
  for (const table of SANITY_CHECK_TABLES) {
    try {
      const sourceCount = sourceForVerify.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
      const backupCount = backupForVerify.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
      rowCounts[table] = { source: sourceCount, backup: backupCount, match: sourceCount === backupCount };
      if (sourceCount !== backupCount) {
        throw new Error(`Row count mismatch in ${table}: source=${sourceCount} backup=${backupCount}`);
      }
    } catch (err) {
      if (err.message.includes("no such table")) continue; // table genuinely doesn't exist yet in a fresh DB — not a failure
      sourceForVerify.close();
      backupForVerify.close();
      throw err;
    }
  }
  sourceForVerify.close();
  backupForVerify.close();
  const verifyDurationMs = Date.now() - verifyStart;

  let finalPath = backupPath;
  let compressedBytes = null;
  if (shouldCompress) {
    const gzPath = backupPath + ".gz";
    await pipeline(fs.createReadStream(backupPath), zlib.createGzip(), fs.createWriteStream(gzPath));
    fs.unlinkSync(backupPath);
    finalPath = gzPath;
    compressedBytes = fs.statSync(gzPath).size;
  }

  const sizeBytes = fs.statSync(finalPath).size;
  const result = {
    ok: true,
    sourcePath,
    backupPath: finalPath,
    sizeBytes,
    totalPages: progressInfo?.totalPages ?? null,
    backupDurationMs,
    verifyDurationMs,
    rowCounts,
    compressed: shouldCompress,
  };
  logger.info("backup.completed", result);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  backupDatabase({ outDir: args.out, compress: args.compress })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Backup failed:", err.message);
      process.exit(1);
    });
}
