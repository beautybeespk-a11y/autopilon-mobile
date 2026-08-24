#!/usr/bin/env bash
# status.sh — a quick, lightweight snapshot of the running stack.
# No monitoring infrastructure is installed by this script (per Phase 20's
# "don't install expensive monitoring infrastructure" instruction) — this
# just surfaces what's already there: Docker's own state, the app's real
# health endpoints, and basic OS resource usage.
#
#   ./status.sh
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$_SCRIPT_DIR/_common.sh"
cd "$APP_DIR"

require_env_file

echo "=============================================================="
echo " Autopilon status — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=============================================================="

echo
echo "-- Containers --"
$COMPOSE ps

echo
echo "-- Health checks --"
run_health_checks || true

echo
echo "-- Redis memory usage --"
$COMPOSE exec -T redis redis-cli info memory 2>/dev/null | grep -E '^used_memory_human|^maxmemory_human' || echo "(could not query Redis)"

echo
echo "-- TLS certificate --"
if [[ -n "${DOMAIN_NAME:-}" ]]; then
  CERT_END="$(echo | openssl s_client -connect "${DOMAIN_NAME}:443" -servername "${DOMAIN_NAME}" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  if [[ -n "$CERT_END" ]]; then
    echo "Expires: $CERT_END"
  else
    echo "Could not read certificate (site may not be reachable yet — see DNS REQUIRED in PRODUCTION_DEPLOYMENT.md)."
  fi
fi

echo
echo "-- Disk --"
df -h "$APP_DIR" | awk 'NR==1 || NR==2'
echo
echo "Docker's own disk usage:"
docker system df

echo
echo "-- Memory --"
free -h

echo
echo "-- Most recent backup --"
if [[ -d "$APP_DIR/backups" ]]; then
  LATEST="$(find "$APP_DIR/backups" -maxdepth 1 -name 'backup-*.sqlite.gz*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  if [[ -n "$LATEST" ]]; then
    echo "$LATEST ($(date -u -r "$LATEST" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || stat -c %y "$LATEST"))"
  else
    echo "No database backups found yet — run ./backup.sh (see BACKUP_RUNBOOK.md for automating this on a schedule)."
  fi
else
  echo "No backups/ directory yet — run ./backup.sh at least once."
fi

echo
echo "-- Deployed image --"
echo "Currently running: $(current_running_image || echo unknown)  (digest $(current_image_digest || echo unknown))"
[[ -f "$STATE_DIR/current-commit" ]] && echo "  commit: $(cat "$STATE_DIR/current-commit"), deployed: $(cat "$STATE_DIR/current-deployed-at" 2>/dev/null || echo unknown)"
if [[ -f "$STATE_DIR/previous-image" ]]; then
  echo "Previous (rollback target): $(cat "$STATE_DIR/previous-image")  (digest $(cat "$STATE_DIR/previous-digest" 2>/dev/null || echo unknown))"
  [[ -f "$STATE_DIR/previous-commit" ]] && echo "  commit: $(cat "$STATE_DIR/previous-commit"), deployed: $(cat "$STATE_DIR/previous-deployed-at" 2>/dev/null || echo unknown)"
fi
