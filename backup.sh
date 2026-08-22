#!/usr/bin/env bash
# backup.sh — real, automated backup of the database and uploaded files.
#
#   ./backup.sh              # database + uploads, compressed, unencrypted
#   ./backup.sh --encrypt    # same, plus AES-256 encryption (you supply a passphrase)
#
# Wraps the EXISTING, already-tested server/scripts/backup-db.js (Phase
# 18.6 — better-sqlite3's native online backup API, safe against a live
# database, does its own integrity_check + row-count verification before
# ever writing the final file) — this script does not reimplement that
# logic, it drives it inside the running `app` container (where the real
# database file actually lives) and adds: uploaded-files backup, host-
# visible storage, retention, optional encryption, and an outer-layer
# integrity check of the resulting archive.
#
# WHERE BACKUPS ARE STORED: ./backups (i.e. $APP_DIR/backups on the VPS —
# a plain directory on local disk, mode 700). This is real and automated,
# but it is NOT off-VPS — a full disk failure would take the backups with
# it. See BACKUP_RUNBOOK.md's "EXTERNAL ACTION REQUIRED" section for
# copying these off-box (rsync to another host, an S3-compatible bucket,
# etc.) — that destination can't be provisioned automatically since it
# needs a real external credential/account this installer doesn't have.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$_SCRIPT_DIR/_common.sh"
cd "$APP_DIR"

require_env_file

BACKUP_DIR="$APP_DIR/backups"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
ENCRYPT=0
[[ "${1:-}" == "--encrypt" ]] && ENCRYPT=1

echo
echo "=============================================================="
echo " Backup — $TS"
echo "=============================================================="

# --- Database (real, tested backup-db.js — see its own header for what
#     it actually does: native online backup API + integrity_check +
#     row-count comparison, throws rather than silently writing a
#     corrupt backup). Writes into /app/backups inside the container,
#     which docker-compose.prod.yml bind-mounts to ./backups on the host.
log "Backing up database (via the existing, tested backup-db.js)..."
$COMPOSE exec -T app node scripts/backup-db.js --out /app/backups --compress

DB_BACKUP="$(find "$BACKUP_DIR" -maxdepth 1 -name 'backup-*.sqlite.gz' -newermt '-2 minutes' -print | sort | tail -1)"
if [[ -z "$DB_BACKUP" ]]; then
  die "backup-db.js reported success but no matching backup-*.sqlite.gz file was found in $BACKUP_DIR — investigate before trusting this backup cycle."
fi
log "Database backup created: $DB_BACKUP"

# --- Uploaded files. Tars from INSIDE the app container (which already
#     has the app_uploads volume mounted at this path) and streams the
#     result straight to a host file — avoids needing to know Docker's
#     generated volume name.
log "Backing up uploaded files..."
UPLOADS_BACKUP="$BACKUP_DIR/uploads-$TS.tar.gz"
if $COMPOSE exec -T app sh -c 'tar czf - -C /app/server/uploads . 2>/dev/null' > "$UPLOADS_BACKUP" && [[ -s "$UPLOADS_BACKUP" ]]; then
  log "Uploads backup created: $UPLOADS_BACKUP"
else
  rm -f "$UPLOADS_BACKUP"
  warn "No uploads to back up (empty uploads directory — normal if the File Manager feature hasn't been used yet)."
fi

# --- Optional encryption (AES-256, passphrase-based via openssl — no
#     extra dependency beyond what install-production.sh already
#     installs). You will need this EXACT passphrase to restore; nothing
#     here stores it anywhere.
if [[ $ENCRYPT -eq 1 ]]; then
  prompt_secret PASSPHRASE "Encryption passphrase for this backup (store it in a password manager — it is NOT saved anywhere by this script, and a lost passphrase means a permanently unreadable backup)"
  [[ -n "$PASSPHRASE" ]] || die "Empty passphrase — refusing to 'encrypt' with nothing."
  for f in "$DB_BACKUP" "$UPLOADS_BACKUP"; do
    [[ -f "$f" ]] || continue
    if openssl enc -aes-256-cbc -pbkdf2 -salt -in "$f" -out "$f.enc" -pass "pass:$PASSPHRASE"; then
      rm -f "$f"
      log "Encrypted: $f.enc"
    else
      err "Encryption failed for $f — leaving the unencrypted file in place."
    fi
  done
  unset PASSPHRASE
fi

# --- Retention: keep the most recent N of each artifact type.
RETAIN="${BACKUP_RETAIN_COUNT:-14}"
log "Applying retention (keeping the $RETAIN most recent of each backup type)..."
for pattern in 'backup-*.sqlite.gz' 'backup-*.sqlite.gz.enc' 'uploads-*.tar.gz' 'uploads-*.tar.gz.enc'; do
  mapfile -t old < <(find "$BACKUP_DIR" -maxdepth 1 -name "$pattern" -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n "+$((RETAIN + 1))" | cut -d' ' -f2-)
  for f in "${old[@]:-}"; do
    [[ -n "$f" ]] || continue
    rm -f -- "$f"
    log "Pruned old backup: $f"
  done
done

# --- Verify the backup is actually usable, not just present.
log "Verifying backup integrity..."
if [[ "$DB_BACKUP" == *.enc ]]; then
  warn "Skipping the outer gzip integrity re-check on an encrypted file (would need the passphrase again) — backup-db.js already verified the database contents (integrity_check + row-count comparison) BEFORE encryption, see its log line above."
elif gzip -t "$DB_BACKUP" 2>/dev/null; then
  log "Database backup archive is intact (gzip -t passed)."
else
  die "Database backup archive failed gzip integrity check — do not trust this backup. Investigate immediately (disk full? interrupted write?)."
fi

echo
log "Backup complete. Contents of $BACKUP_DIR:"
ls -lh "$BACKUP_DIR" | tail -n +2
echo
echo "Restore with: ./restore.sh <backup-file>  (see BACKUP_RUNBOOK.md)"
