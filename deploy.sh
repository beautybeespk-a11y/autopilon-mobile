#!/usr/bin/env bash
# deploy.sh — pull and deploy a new version of the application.
#
#   ./deploy.sh              # deploy whatever IMAGE_TAG is currently set to in .env (default: latest)
#   ./deploy.sh v1.2.3       # deploy a specific tag (e.g. a sha-<commit> tag from build-and-push.yml)
#
# What this does, in order:
#   1. Records the currently-running image as "previous" (for rollback.sh).
#   2. Updates this checkout (git fetch + reset --hard to the current
#      branch) — picks up any docker-compose.yml/script changes, never
#      touches .env or backups/ (both untracked by git).
#   3. Pulls the target image from GitHub Container Registry.
#   4. Restarts containers with `docker compose up -d` — this recreates
#      containers, it does NOT touch named volumes (app_data, app_uploads,
#      redis_data, traefik_letsencrypt), so the database, uploaded files,
#      Redis data, and TLS certificate all survive untouched. Nothing
#      here ever runs `docker compose down -v`.
#   5. No separate migration step: server/db.js applies any new additive
#      schema changes (PRAGMA-guarded ALTER TABLE ADD COLUMN) automatically
#      the moment the new `app`/`worker` containers boot — there is no
#      separate migration framework to invoke (see PRODUCTION_READINESS.md
#      §"Migration rollback strategy" / PHASE19_NOTES.md §3).
#   6. Runs the same real health checks install-production.sh uses.
#   7. On success, records the new image as "current". On failure, tells
#      you the exact previous-good image and to run ./rollback.sh.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$_SCRIPT_DIR/_common.sh"
cd "$APP_DIR"

require_env_file
mkdir_state

TARGET_TAG="${1:-${IMAGE_TAG:-latest}}"

echo
echo "=============================================================="
echo " Deploying ${IMAGE_REPO:-<IMAGE_REPO unset in .env>}:${TARGET_TAG}"
echo "=============================================================="

# 1. Record the currently-running image so rollback.sh has something real
#    to go back to — read straight from Docker, not from .env (which
#    could already be stale relative to what's actually deployed).
PREV_IMAGE="$(current_running_image)"
if [[ -n "$PREV_IMAGE" ]]; then
  echo "$PREV_IMAGE" > "$STATE_DIR/previous-image"
  log "Recorded currently-running image for rollback: $PREV_IMAGE"
else
  warn "No currently-running 'app' container found — nothing to record as 'previous' yet. Expected right after a fresh install; rollback.sh will have nothing to revert to until this deploy completes and a later one runs."
fi

# 2. Update the checkout itself (compose files, helper scripts) — refuse
#    to clobber unexpected local edits to tracked files. .env and
#    backups/ are both gitignored, so this never touches them regardless.
if [[ -d .git ]]; then
  DIRTY="$(git status --porcelain --untracked-files=no 2>/dev/null || true)"
  if [[ -n "$DIRTY" ]]; then
    err "Local modifications to tracked files detected — refusing to overwrite them:"
    echo "$DIRTY" >&2
    die "Commit, stash, or discard these first, or investigate why they're there before re-running deploy.sh."
  fi
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  log "Updating checkout (git fetch + reset --hard origin/$BRANCH)..."
  git fetch --depth 1 origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  warn "Not a git checkout — skipping repository update, deploying the image only."
fi

# 3. Update IMAGE_TAG in .env if a specific tag was requested.
if [[ "$TARGET_TAG" != "${IMAGE_TAG:-}" ]]; then
  if grep -q '^IMAGE_TAG=' .env; then
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${TARGET_TAG}|" .env
  else
    echo "IMAGE_TAG=${TARGET_TAG}" >> .env
  fi
  log "Updated .env: IMAGE_TAG=${TARGET_TAG}"
fi
require_env_file # reload with the (possibly just-updated) tag

log "Pulling ${IMAGE_REPO}:${IMAGE_TAG}..."
if ! $COMPOSE pull; then
  die "Pull failed for ${IMAGE_REPO}:${IMAGE_TAG}. If this tag was just pushed by build-and-push.yml, GitHub Actions may still be running — check the Actions tab. If the GHCR package is private, see install-production.sh's registry-access step / PRODUCTION_DEPLOYMENT.md for how to 'docker login ghcr.io' on this VPS."
fi

log "Restarting containers (named volumes are preserved — this never runs 'docker compose down -v')..."
$COMPOSE up -d --remove-orphans

log "No separate migration step needed — the new containers apply any additive schema changes automatically on boot."

log "Running health checks..."
if run_health_checks; then
  echo "${IMAGE_REPO}:${IMAGE_TAG}" > "$STATE_DIR/current-image"
  log "Deploy succeeded and is healthy: ${IMAGE_REPO}:${IMAGE_TAG}"
  exit 0
else
  err "Deploy completed but one or more health checks failed."
  if [[ -n "$PREV_IMAGE" ]]; then
    err "Previous known-good image: $PREV_IMAGE — run ./rollback.sh to revert to it."
  else
    err "No previous image was recorded to roll back to (see warning above) — investigate with ./logs.sh <service> before deciding next steps."
  fi
  exit 1
fi
