#!/usr/bin/env bash
# restore.sh — restore the database (or an uploads backup) from a file
# produced by backup.sh / server/scripts/backup-db.js.
#
#   ./restore.sh backup-2026-01-15T03-00-00-000Z.sqlite.gz
#   ./restore.sh uploads-20260115T030000Z.tar.gz
#   ./restore.sh <file> --yes         # skip the confirmation prompt
#
# Accepts either a bare filename (looked up in ./backups) or a full path.
# Wraps the EXISTING, already-tested server/scripts/restore-db.js for the
# database case (Phase 18.6 — verifies the backup with PRAGMA
# integrity_check BEFORE touching anything live, and makes a timestamped
# safety copy of the CURRENT database before overwriting it, so a bad
# restore decision is itself reversible).
#
# The app and worker are stopped for the duration of a database restore
# (Redis and Traefik keep running, so the domain stays resolvable — it'll
# just show a connection error until the restore finishes and containers
# restart, typically well under a minute). This is deliberate: replacing
# the database file out from under a live, writing process risks
# corruption in a way the original backup mechanism's "safe against a
# live database" guarantee does not extend to restores.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$_SCRIPT_DIR/_common.sh"
cd "$APP_DIR"

require_env_file

BACKUP_DIR="$APP_DIR/backups"
INPUT="${1:-}"
ASSUME_YES=0
[[ "${2:-}" == "--yes" ]] && ASSUME_YES=1

[[ -n "$INPUT" ]] || die "Usage: ./restore.sh <backup-file> [--yes]   (run ./status.sh or 'ls backups/' to see what's available)"

if [[ -f "$INPUT" ]]; then
  BACKUP_PATH="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
elif [[ -f "$BACKUP_DIR/$INPUT" ]]; then
  BACKUP_PATH="$BACKUP_DIR/$INPUT"
else
  die "Backup file not found: $INPUT (looked in the given path and in $BACKUP_DIR)"
fi

BASENAME="$(basename "$BACKUP_PATH")"
WORK="$BACKUP_PATH"
DECRYPTED_TMP=""

if [[ "$BASENAME" == *.enc ]]; then
  prompt_secret PASSPHRASE "Decryption passphrase for $BASENAME (input hidden)"
  DECRYPTED_TMP="$(mktemp "${BACKUP_DIR}/.restore-decrypt-XXXXXX")"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -in "$BACKUP_PATH" -out "$DECRYPTED_TMP" -pass "pass:$PASSPHRASE"; then
    rm -f "$DECRYPTED_TMP"
    die "Decryption failed — wrong passphrase, or the file is corrupt."
  fi
  unset PASSPHRASE
  WORK="$DECRYPTED_TMP"
  BASENAME="${BASENAME%.enc}"
  log "Decrypted to a temporary file (removed automatically when this script exits)."
fi
trap '[[ -n "$DECRYPTED_TMP" ]] && rm -f "$DECRYPTED_TMP"' EXIT

echo
echo "=============================================================="
if [[ "$BASENAME" == uploads-*.tar.gz ]]; then
  RESTORE_KIND=uploads
  echo " Restore UPLOADED FILES from: $BASENAME"
elif [[ "$BASENAME" == backup-*.sqlite.gz || "$BASENAME" == *.sqlite ]]; then
  RESTORE_KIND=database
  echo " Restore DATABASE from: $BASENAME"
else
  die "Don't recognize '$BASENAME' as either a database backup (backup-*.sqlite.gz) or an uploads backup (uploads-*.tar.gz)."
fi
echo "=============================================================="
echo " This will:"
if [[ "$RESTORE_KIND" == database ]]; then
  echo "   1. Stop the app + worker containers (Redis/Traefik keep running)"
  echo "   2. Save a timestamped safety copy of the CURRENT database first"
  echo "   3. Replace the database with the contents of this backup"
  echo "   4. Restart app + worker and run health checks"
else
  echo "   1. Stop the app + worker containers"
  echo "   2. Save a timestamped safety copy of the CURRENT uploads directory"
  echo "   3. Extract this backup over the uploads directory"
  echo "   4. Restart app + worker and run health checks"
fi
echo "=============================================================="

if [[ $ASSUME_YES -ne 1 ]]; then
  if ! prompt_yn "Proceed?" n; then
    log "Restore cancelled."
    exit 0
  fi
fi

log "Stopping app + worker (Redis/Traefik stay up)..."
$COMPOSE stop app worker

if [[ "$RESTORE_KIND" == database ]]; then
  # Copy the (possibly just-decrypted) backup file into the bind-mounted
  # backups dir under a fixed name a one-off container can reach, run the
  # real restore-db.js there (docker compose run, not exec — app is
  # stopped, so there's nothing to exec into), then clean up the copy.
  RESTORE_STAGE="$BACKUP_DIR/.restore-staged-$(date +%s).sqlite.gz"
  cp "$WORK" "$RESTORE_STAGE"
  trap '[[ -n "$DECRYPTED_TMP" ]] && rm -f "$DECRYPTED_TMP"; rm -f "$RESTORE_STAGE"' EXIT

  log "Running restore-db.js (makes its own safety copy of the current database first)..."
  if $COMPOSE run --rm --no-deps -T app node scripts/restore-db.js "/app/backups/$(basename "$RESTORE_STAGE")" --target /app/data/app.sqlite --force; then
    log "Database restored."
  else
    err "restore-db.js failed — the previous database should be untouched (it only overwrites after its own verification passes). Check the output above."
    log "Restarting app + worker on the existing (unrestored) database..."
    $COMPOSE up -d --remove-orphans app worker
    exit 1
  fi
else
  UPLOADS_SAFETY="$BACKUP_DIR/uploads-pre-restore-safety-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  log "Saving a safety copy of the current uploads directory to $UPLOADS_SAFETY..."
  $COMPOSE run --rm --no-deps -T -v "$BACKUP_DIR:/app/backups" app \
    sh -c "tar czf /app/backups/$(basename "$UPLOADS_SAFETY") -C /app/server/uploads . 2>/dev/null || true"

  log "Extracting backup over the uploads directory..."
  cp "$WORK" "$BACKUP_DIR/.restore-staged-uploads.tar.gz"
  $COMPOSE run --rm --no-deps -T app \
    sh -c "tar xzf /app/backups/.restore-staged-uploads.tar.gz -C /app/server/uploads"
  rm -f "$BACKUP_DIR/.restore-staged-uploads.tar.gz"
  log "Uploads restored (previous contents saved to $UPLOADS_SAFETY)."
fi

log "Restarting app + worker..."
$COMPOSE up -d --remove-orphans app worker

log "Running health checks..."
if run_health_checks; then
  log "Restore succeeded and the application is healthy."
else
  err "Restore finished but health checks failed — check ./logs.sh app and ./logs.sh worker."
  exit 1
fi
