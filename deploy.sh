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
#    could already be stale relative to what's actually deployed). Also
#    records the image DIGEST (immutable, unlike the tag — two genuinely
#    different deploys can both be tagged "latest") plus which git commit
#    and when, so "previous version" is a real, identifiable thing even
#    when the tag alone can't tell two builds apart.
PREV_IMAGE="$(current_running_image)"
PREV_DIGEST="$(current_image_digest)"
if [[ -n "$PREV_IMAGE" ]]; then
  echo "$PREV_IMAGE" > "$STATE_DIR/previous-image"
  echo "$PREV_DIGEST" > "$STATE_DIR/previous-digest"
  # Carry forward whatever commit/timestamp the LAST successful deploy
  # recorded as "current" — that's the real provenance of what's running
  # right now, not something this run can know on its own.
  [[ -f "$STATE_DIR/current-commit" ]] && cp "$STATE_DIR/current-commit" "$STATE_DIR/previous-commit"
  [[ -f "$STATE_DIR/current-deployed-at" ]] && cp "$STATE_DIR/current-deployed-at" "$STATE_DIR/previous-deployed-at"
  log "Recorded currently-running image for rollback: $PREV_IMAGE ($PREV_DIGEST)"
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
  BEFORE_HASH="$(git rev-parse HEAD)"
  log "Updating checkout (git fetch + reset --hard origin/$BRANCH)..."
  git fetch --depth 1 origin "$BRANCH"
  git reset --hard "origin/$BRANCH"

  # If that update changed anything — deploy.sh itself included — the
  # already-running process is still executing the OLD file content from
  # memory; bash doesn't notice its own script changing underneath it
  # mid-run. Re-exec from scratch rather than risk silently running stale
  # logic for the rest of this deploy (confirmed live: a fix to the
  # fallback logic below this point had zero effect on the run that
  # updated it, because the running process never picked it up without
  # this). Harmless no-op re-run if only unrelated files changed.
  if [[ "$(git rev-parse HEAD)" != "$BEFORE_HASH" && -z "${DEPLOY_SH_REEXECED:-}" ]]; then
    log "This update changed the checkout — re-executing deploy.sh from the start to pick up any changes to it..."
    exec env DEPLOY_SH_REEXECED=1 "${BASH_SOURCE[0]}" "$@"
  fi
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

GIT_SHA="$(current_git_commit)"

log "Pulling ${IMAGE_REPO}:${IMAGE_TAG}..."
if ! $COMPOSE pull app worker; then
  warn "Pull failed for ${IMAGE_REPO}:${IMAGE_TAG} — falling back to building on this VPS instead (same path install-production.sh uses when no pre-built image is available yet, e.g. before this branch's first build-and-push.yml run, or while the GHCR package is still private). If this tag was just pushed by build-and-push.yml, GitHub Actions may still be running — check the Actions tab. If the GHCR package is private, see install-production.sh's registry-access step / PRODUCTION_DEPLOYMENT.md for how to 'docker login ghcr.io' on this VPS instead."
  $COMPOSE build app worker
  $COMPOSE pull redis traefik
  # A locally-built image is tagged ${IMAGE_TAG} (usually the floating
  # "latest") by the compose build itself — indistinguishable from any
  # OTHER local build also tagged "latest". Stamp a second, permanent tag
  # keyed by git commit so this specific build stays identifiable and
  # reachable even after a later deploy moves "latest" elsewhere.
  LOCAL_VERSION_TAG="local-${GIT_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
  docker tag "${IMAGE_REPO}:${IMAGE_TAG}" "${IMAGE_REPO}:${LOCAL_VERSION_TAG}"
  log "Tagged this build as ${IMAGE_REPO}:${LOCAL_VERSION_TAG} (permanent, in addition to :${IMAGE_TAG})."
fi

log "Restarting containers (named volumes are preserved — this never runs 'docker compose down -v')..."
$COMPOSE up -d --remove-orphans

log "No separate migration step needed — the new containers apply any additive schema changes automatically on boot."

log "Running health checks..."
if run_health_checks; then
  echo "${IMAGE_REPO}:${IMAGE_TAG}" > "$STATE_DIR/current-image"
  current_image_digest > "$STATE_DIR/current-digest"
  echo "$GIT_SHA" > "$STATE_DIR/current-commit"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/current-deployed-at"
  log "Deploy succeeded and is healthy: ${IMAGE_REPO}:${IMAGE_TAG} (commit $GIT_SHA, digest $(current_image_digest))"
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
