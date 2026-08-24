#!/usr/bin/env bash
# rollback.sh — return to the previously deployed image.
#
#   ./rollback.sh          # asks for confirmation first
#   ./rollback.sh --yes    # skip the confirmation prompt (e.g. from a script)
#
# How this works: deploy.sh records the image that was running immediately
# BEFORE each deploy into .deploy-state/previous-image. rollback.sh reads
# that file, points IMAGE_TAG in .env back at it, and restarts the
# containers on that image — the exact reverse of what deploy.sh just did.
#
# What is preserved (i.e. everything — rollback only ever changes WHICH
# CODE is running, never touches data):
#   - users, organizations, agents, tasks, projects, integrations,
#     conversations, settings — all of it lives in the app_data volume
#     (the SQLite database), never recreated or modified by this script.
#   - uploaded files (app_uploads volume).
#   - Redis data (redis_data volume) and the Let's Encrypt certificate
#     (traefik_letsencrypt volume).
# Rolling back to an OLDER version against a database a NEWER version may
# have already written additive columns to is safe: this app's schema
# changes are exclusively additive (PRAGMA-guarded ALTER TABLE ADD
# COLUMN, never DROP/RENAME — verified by source audit, see
# PRODUCTION_READINESS.md's "Migration rollback strategy" entry) — older
# code simply ignores columns it doesn't know about.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$_SCRIPT_DIR/_common.sh"
cd "$APP_DIR"

require_env_file
mkdir_state

ASSUME_YES=0
[[ "${1:-}" == "--yes" ]] && ASSUME_YES=1

PREV_FILE="$STATE_DIR/previous-image"
if [[ ! -f "$PREV_FILE" ]]; then
  die "No previous deployment is recorded yet ($PREV_FILE doesn't exist). This is expected if ./deploy.sh has never been run — there is nothing to roll back to before the very first deploy. If you need to revert the INITIAL install, re-run ./install-production.sh with a known-good IMAGE_TAG instead."
fi

PREV_IMAGE="$(cat "$PREV_FILE")"
[[ -n "$PREV_IMAGE" ]] || die "Recorded previous image is empty — refusing to roll back to nothing. Check $PREV_FILE."

CURRENT_IMAGE="$(current_running_image)"
CURRENT_DIGEST="$(current_image_digest)"
PREV_TAG="${PREV_IMAGE##*:}"
PREV_DIGEST="$(cat "$STATE_DIR/previous-digest" 2>/dev/null || echo "unknown")"
PREV_COMMIT="$(cat "$STATE_DIR/previous-commit" 2>/dev/null || echo "unknown")"
PREV_DEPLOYED_AT="$(cat "$STATE_DIR/previous-deployed-at" 2>/dev/null || echo "unknown")"

echo
echo "=============================================================="
echo " Rollback"
echo "=============================================================="
echo " Currently running: ${CURRENT_IMAGE:-unknown} (digest ${CURRENT_DIGEST:-unknown})"
echo " Will roll back to: ${PREV_IMAGE} (digest ${PREV_DIGEST})"
echo "   commit: ${PREV_COMMIT}, deployed: ${PREV_DEPLOYED_AT}"
echo " Data preserved:    database, uploads, Redis data, TLS cert (all untouched)"
echo "=============================================================="

# Compare by DIGEST, not tag string — two genuinely different builds can
# both be tagged "latest" (the exact scenario that made rollback a no-op
# before per-deploy version tagging existed). Falls back to a tag
# comparison only if a digest is missing (e.g. state predates this check).
if [[ -n "$CURRENT_DIGEST" && -n "$PREV_DIGEST" && "$PREV_DIGEST" != "unknown" ]]; then
  if [[ "$CURRENT_DIGEST" == "$PREV_DIGEST" ]]; then
    warn "Currently-running image is already the same build (digest $CURRENT_DIGEST) as the recorded 'previous' — nothing to do."
    exit 0
  fi
elif [[ "$CURRENT_IMAGE" == "$PREV_IMAGE" ]]; then
  warn "Currently-running image already matches the recorded 'previous' image tag, and no digest was recorded to check further — nothing to do."
  exit 0
fi

if [[ $ASSUME_YES -ne 1 ]]; then
  if ! prompt_yn "Proceed with rollback?" n; then
    log "Rollback cancelled."
    exit 0
  fi
fi

if grep -q '^IMAGE_TAG=' .env; then
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREV_TAG}|" .env
else
  echo "IMAGE_TAG=${PREV_TAG}" >> .env
fi
log "Updated .env: IMAGE_TAG=${PREV_TAG}"
require_env_file

log "Pulling ${PREV_IMAGE}..."
# A best-effort pull, not a hard requirement: deploy.sh's local-build
# fallback path tags images like "local-<commit>-<timestamp>" that only
# ever exist on THIS Docker daemon, never pushed to any registry — pulling
# one of those is EXPECTED to fail. If the image genuinely doesn't exist
# anywhere (not pulled, not local), the follow-up `up -d` fails loudly and
# clearly instead, which is the right place for that error to surface.
$COMPOSE pull || warn "Pull failed for ${PREV_IMAGE} — expected if this is a local-only version tag (never pushed to a registry). Continuing with whatever image already exists locally under this tag."

log "Restarting containers on the previous image (named volumes untouched)..."
$COMPOSE up -d --remove-orphans

log "Running health checks..."
if run_health_checks; then
  # Swap the recorded state: what we just rolled back TO is now
  # "current," and what we rolled back FROM becomes the new "previous" —
  # so running rollback.sh a second time in a row correctly rolls
  # forward again instead of being a no-op.
  echo "$PREV_IMAGE" > "$STATE_DIR/current-image"
  echo "$PREV_DIGEST" > "$STATE_DIR/current-digest"
  echo "$PREV_COMMIT" > "$STATE_DIR/current-commit"
  echo "$PREV_DEPLOYED_AT" > "$STATE_DIR/current-deployed-at"
  if [[ -n "$CURRENT_IMAGE" ]]; then
    echo "$CURRENT_IMAGE" > "$STATE_DIR/previous-image"
    echo "$CURRENT_DIGEST" > "$STATE_DIR/previous-digest"
  fi
  log "Rollback succeeded and is healthy: $PREV_IMAGE (commit $PREV_COMMIT, digest $PREV_DIGEST)"
else
  err "Rollback completed but health checks failed. This means BOTH the version you rolled back from AND the one you rolled back to are showing problems right now — check ./logs.sh for every service (traefik, app, worker, redis), this is likely an infrastructure issue (DNS, Redis, disk) rather than an application-version issue."
  exit 1
fi
