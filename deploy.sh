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

# EXPECTED_REVISION: the full-length commit this deploy targets,
# independent of whatever ends up actually running — computed BEFORE the
# pull so it can catch a stale registry tag immediately below, not just
# after wastefully restarting/health-checking against it.
EXPECTED_REVISION=""
if [[ "$IMAGE_TAG" =~ ^sha-([0-9a-f]{40})$ ]]; then
  EXPECTED_REVISION="${BASH_REMATCH[1]}"
elif [[ "$IMAGE_TAG" == "latest" && -d .git ]]; then
  EXPECTED_REVISION="$(git rev-parse HEAD)"
fi

log "Pulling ${IMAGE_REPO}:${IMAGE_TAG}..."
NEED_LOCAL_BUILD=0
if ! $COMPOSE pull app worker; then
  warn "Pull failed for ${IMAGE_REPO}:${IMAGE_TAG} — falling back to building on this VPS instead (same path install-production.sh uses when no pre-built image is available yet, e.g. before this branch's first build-and-push.yml run, or while the GHCR package is still private). If this tag was just pushed by build-and-push.yml, GitHub Actions may still be running — check the Actions tab. If the GHCR package is private, see install-production.sh's registry-access step / PRODUCTION_DEPLOYMENT.md for how to 'docker login ghcr.io' on this VPS instead."
  NEED_LOCAL_BUILD=1
elif [[ -n "$EXPECTED_REVISION" ]]; then
  # CONFIRMED LIVE BUG, requirement 3: the pull can succeed while still
  # handing us STALE code — build-and-push.yml is workflow_dispatch-only
  # (never auto-triggers on push), so ":latest" in GHCR can sit unchanged
  # across several commits. Check the label on the image we JUST pulled
  # before ever touching the running containers, so a doomed
  # restart+health-check cycle never even starts. Never silently deploy
  # an older image — either build fresh from this checkout (below) or the
  # post-restart gate further down catches it as a hard failure.
  PULLED_REVISION="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${IMAGE_REPO}:${IMAGE_TAG}" 2>/dev/null || true)"
  if [[ -n "$PULLED_REVISION" && "$PULLED_REVISION" != "$EXPECTED_REVISION" ]]; then
    warn "The pulled ${IMAGE_REPO}:${IMAGE_TAG} image was built from commit $PULLED_REVISION, not the commit this deploy targets ($EXPECTED_REVISION) — build-and-push.yml has not (re)built this tag for the latest commit(s) yet. Falling back to building on this VPS instead of deploying stale code. (Trigger build-and-push.yml — workflow_dispatch works on any branch — if you'd rather deploy the real GHCR image once it exists.)"
    NEED_LOCAL_BUILD=1
  fi
fi

USED_LOCAL_FALLBACK_BUILD=0
if [[ "$NEED_LOCAL_BUILD" == "1" ]]; then
  USED_LOCAL_FALLBACK_BUILD=1
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

# The digest of whatever image is now tagged :${IMAGE_TAG} locally —
# just pulled from the registry, or just built above — is exactly what
# this deploy is targeting for the containers to end up running. This is
# requirement 1's "digest the deploy targeted."
TARGET_DIGEST="$(docker inspect -f '{{.Id}}' "${IMAGE_REPO}:${IMAGE_TAG}" 2>/dev/null || true)"
[[ -n "$TARGET_DIGEST" ]] || warn "Could not determine the target image's digest (docker inspect on ${IMAGE_REPO}:${IMAGE_TAG} returned nothing) — the post-restart verification below will only be able to check StartedAt, not digest."

# Distinguish "legitimately nothing changed" (this exact image was
# already running — e.g. deploy.sh re-run with no new commit) from "the
# restart should have happened but didn't." Only the latter is a bug.
ALREADY_UP_TO_DATE=0
if [[ -n "$PREV_DIGEST" && -n "$TARGET_DIGEST" && "$PREV_DIGEST" == "$TARGET_DIGEST" ]]; then
  log "The currently-running containers already match this target image (digest $TARGET_DIGEST) — nothing to restart."
  ALREADY_UP_TO_DATE=1
fi

log "Restarting containers (named volumes are preserved — this never runs 'docker compose down -v')..."
DEPLOY_OP_START_EPOCH="$(date -u +%s)"
$COMPOSE up -d --remove-orphans

# CONFIRMED LIVE BUG, seen twice in production: `docker compose up -d` is
# a silent no-op for a service whose target image digest hasn't actually
# changed from what's already running — e.g. a stale :latest in GHCR that
# hadn't been rebuilt since the last push. Docker prints "Running 0.0s"
# (not "Started") for that service, the OLD container just keeps going
# untouched (an hours-old StartedAt), and the health checks below then
# pass against it — this script would otherwise report success at a
# commit that was never actually deployed. The previous defense here
# (comparing only the running image's org.opencontainers.image.revision
# label, and only warning when it was absent) had a real gap: a
# locally-built fallback image carries no such label at all, so that path
# was silently unverifiable. verify_container_restarted() (_common.sh) is
# the hard, unconditional replacement — requirements 1+2: it compares the
# running container's actual image digest against TARGET_DIGEST above,
# AND confirms its StartedAt is genuinely at-or-after DEPLOY_OP_START_EPOCH.
# Either failing is a hard stop, never a mere warning.
if [[ "$ALREADY_UP_TO_DATE" == "1" ]]; then
  log "Skipping restart verification — already confirmed above that nothing needed to restart."
  APP_VERIFY_OK=1
  WORKER_VERIFY_OK=1
else
  if verify_container_restarted app "$TARGET_DIGEST" "$DEPLOY_OP_START_EPOCH"; then APP_VERIFY_OK=1; else APP_VERIFY_OK=0; fi
  if verify_container_restarted worker "$TARGET_DIGEST" "$DEPLOY_OP_START_EPOCH"; then WORKER_VERIFY_OK=1; else WORKER_VERIFY_OK=0; fi
fi

# Requirement 4: what's ACTUALLY running right now, straight from Docker
# — printed below on every path (success, health-check failure, and
# restart-verification failure) so it's visible without a second command.
RUNNING_REVISION_NOW="$(current_image_revision app)"
RUNNING_DIGEST_NOW="$(current_image_digest app)"

if [[ "$APP_VERIFY_OK" != "1" || "$WORKER_VERIFY_OK" != "1" ]]; then
  err "Deploy did not actually take effect — see the errors above for which service never restarted."
  err "Currently running: commit ${RUNNING_REVISION_NOW:-unknown} (digest ${RUNNING_DIGEST_NOW:-unknown}) — this deploy targeted commit ${EXPECTED_REVISION:-$GIT_SHA} (digest ${TARGET_DIGEST:-unknown})."
  if [[ -n "$PREV_IMAGE" ]]; then
    err "This is the same image that was already running before this deploy started ($PREV_IMAGE) — no rollback is needed, nothing changed. Investigate why the restart didn't happen (often: build-and-push.yml hasn't rebuilt :${IMAGE_TAG} for the latest commit yet — trigger it, or deploy an explicit ./deploy.sh sha-<commit> tag), then re-run ./deploy.sh."
  fi
  die "Refusing to report success: this deploy is not what's actually running."
fi

log "No separate migration step needed — the new containers apply any additive schema changes automatically on boot."

log "Running health checks..."
if run_health_checks; then
  echo "${IMAGE_REPO}:${IMAGE_TAG}" > "$STATE_DIR/current-image"
  echo "$RUNNING_DIGEST_NOW" > "$STATE_DIR/current-digest"
  echo "$GIT_SHA" > "$STATE_DIR/current-commit"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/current-deployed-at"
  log "Deploy succeeded and is healthy: ${IMAGE_REPO}:${IMAGE_TAG} ($([[ "$USED_LOCAL_FALLBACK_BUILD" == "1" ]] && echo "built locally on this VPS" || echo "pulled from the registry"))"
  log "Running commit: ${RUNNING_REVISION_NOW:-$GIT_SHA} (digest ${RUNNING_DIGEST_NOW:-unknown}) — verified genuinely restarted, not stale."
  exit 0
else
  err "Deploy completed but one or more health checks failed."
  err "Running commit: ${RUNNING_REVISION_NOW:-$GIT_SHA} (digest ${RUNNING_DIGEST_NOW:-unknown}) — this part DID actually restart; the failure is in the health checks themselves, not staleness."
  if [[ -n "$PREV_IMAGE" ]]; then
    err "Previous known-good image: $PREV_IMAGE — run ./rollback.sh to revert to it."
  else
    err "No previous image was recorded to roll back to (see warning above) — investigate with ./logs.sh <service> before deciding next steps."
  fi
  exit 1
fi
