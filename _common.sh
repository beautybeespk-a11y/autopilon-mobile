#!/usr/bin/env bash
# _common.sh — shared helpers for the Phase 20 operational scripts
# (deploy.sh, rollback.sh, backup.sh, restore.sh, status.sh, logs.sh).
# Not an entrypoint itself — sourced by the others (`source _common.sh`).
# Exists purely so the health-check/logging logic used by several scripts
# isn't duplicated four times; nothing application-specific lives here
# that isn't already in docker-compose.yml/docker-compose.prod.yml.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP_DIR/.env"
STATE_DIR="$APP_DIR/.deploy-state"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'
log()  { printf "${C_BOLD}${C_GREEN}==>${C_RESET} %s\n" "$1"; }
warn() { printf "${C_BOLD}${C_YELLOW}WARN:${C_RESET} %s\n" "$1" >&2; }
err()  { printf "${C_BOLD}${C_RED}ERROR:${C_RESET} %s\n" "$1" >&2; }
die()  { err "$1"; exit 1; }

require_env_file() {
  [[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE — run ./install-production.sh first."
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
}

mkdir_state() { mkdir -p "$STATE_DIR"; }

# All three prompt functions below read from /dev/tty explicitly, not
# plain stdin. When this script is run as `curl ... | sudo bash` (the
# documented one-command install path), stdin is connected to the pipe
# carrying the script's own source, not the user's terminal — a plain
# `read` would silently get EOF/empty input instead of waiting for real
# input. /dev/tty is the actual controlling terminal whenever one exists
# (an interactive SSH session, piped or not) and is absent only in a
# genuinely non-interactive context (cron, CI), which is exactly the
# case each function's non-interactive fallback below is for.
_has_tty() { [[ -r /dev/tty ]] 2>/dev/null; }

# Visible prompt with an optional default. Secrets use prompt_secret()
# instead so nothing sensitive is ever echoed to the terminal/history.
prompt() {
  local __var="$1" __text="$2" __default="${3:-}" __input
  if _has_tty; then
    if [[ -n "$__default" ]]; then
      read -r -p "$__text [$__default]: " __input < /dev/tty || true
      __input="${__input:-$__default}"
    else
      read -r -p "$__text: " __input < /dev/tty || true
    fi
  else
    __input="$__default"
  fi
  printf -v "$__var" '%s' "$__input"
}

prompt_secret() {
  local __var="$1" __text="$2" __input
  if _has_tty; then
    read -r -s -p "$__text (input hidden): " __input < /dev/tty || true
    echo
    # No visual feedback while typing/pasting a hidden field means there's
    # no way to tell if a paste landed once, landed three times (a real
    # incident: a corrupted, multi-pasted OpenAI key caused every AI
    # request to fail with a 401 until this was noticed), or didn't land
    # at all. Echoing the character count — never the value — gives an
    # immediate, safe sanity check without compromising the secret.
    if [[ -n "$__input" ]]; then
      log "Received ${#__input} characters."
    fi
  else
    __input=""
  fi
  printf -v "$__var" '%s' "$__input"
}

# Returns success (0) for yes. In a non-interactive context (no TTY —
# e.g. driven by cron or CI) falls back to the default rather than
# hanging forever on a `read` that will never get input.
prompt_yn() {
  local __text="$1" __default="${2:-y}" __input
  if ! _has_tty; then
    [[ "$__default" == y ]]
    return
  fi
  read -r -p "$__text [$([[ $__default == y ]] && echo Y/n || echo y/N)]: " __input < /dev/tty || true
  __input="${__input:-$__default}"
  [[ "$__input" =~ ^[Yy] ]]
}

# Returns the exact image reference (repo:tag) the given container
# (service name, default "app") is CURRENTLY running, straight from
# Docker — not from .env, which could be stale relative to what's
# actually deployed.
current_running_image() {
  local svc="${1:-app}" cid
  cid="$(cd "$APP_DIR" && $COMPOSE ps -q "$svc" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { echo ""; return; }
  docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || echo ""
}

# Returns the CURRENTLY-running container's (default "app") actual local
# image ID (a content digest, e.g. "sha256:abc123...") — immutable and
# distinct per build, unlike current_running_image()'s tag string, which
# can be the same floating "latest" across two genuinely different
# deploys. This is what lets deploy.sh/rollback.sh tell two
# "latest"-tagged builds apart.
current_image_digest() {
  local svc="${1:-app}" cid
  cid="$(cd "$APP_DIR" && $COMPOSE ps -q "$svc" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { echo ""; return; }
  docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || echo ""
}

# The CURRENTLY-running container's (default "app") org.opencontainers.
# image.revision label — the exact git commit build-and-push.yml built
# the image from (baked in at build time, see
# .github/workflows/build-and-push.yml). Empty string if the container
# isn't running, or if its image has no such label (e.g. a locally-built
# fallback image, which carries no labels at all — nothing in this repo's
# `docker compose build` path stamps one — or an image built before this
# label existed). Never rely on this alone to detect a stale deploy (see
# verify_container_restarted() below) — it's for display/cross-reference
# only, since it's silently absent exactly on the local-build path.
current_image_revision() {
  local svc="${1:-app}" cid
  cid="$(cd "$APP_DIR" && $COMPOSE ps -q "$svc" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { echo ""; return; }
  docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$cid" 2>/dev/null || echo ""
}

# The CURRENTLY-running container's (default "app") State.StartedAt
# timestamp (RFC3339Nano UTC, e.g. "2026-09-02T10:15:23.123456789Z").
# Empty string if the container isn't running.
current_container_started_at() {
  local svc="${1:-app}" cid
  cid="$(cd "$APP_DIR" && $COMPOSE ps -q "$svc" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { echo ""; return; }
  docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null || echo ""
}

# Epoch seconds for an RFC3339 timestamp, or 0 if it can't be parsed
# (empty/missing input) — 0 always compares as "before" any real deploy
# start time, so callers get a safe (failing-closed) comparison rather
# than a crash.
_epoch_of() {
  [[ -n "${1:-}" ]] || { echo 0; return; }
  date -u -d "$1" +%s 2>/dev/null || echo 0
}

# CONFIRMED LIVE BUG, seen twice in production: `docker compose up -d` is
# a silent no-op for a service whose target image digest hasn't actually
# changed from what's already running — e.g. a stale :latest in GHCR that
# hadn't been rebuilt since the last push. Docker prints "Running 0.0s"
# (not "Started"/"Recreated") for that service, the OLD container just
# keeps going untouched (an hours-old StartedAt), and the calling script's
# health checks then pass against it — deploy.sh/rollback.sh would
# otherwise report success at a commit that was never actually deployed.
# The one previous defense (comparing the running image's
# org.opencontainers.image.revision label) only worked when that label
# was present, which it never is on a locally-built fallback image — a
# real gap. This is the unconditional, unskippable check: compare the
# running container's actual image digest against the digest the caller
# targeted, AND confirm the container's StartedAt is genuinely at or
# after this operation began. Either failing means nothing was really
# restarted, full stop — never merely warned about.
#   $1 = compose service name (e.g. "app", "worker")
#   $2 = the image digest (local image ID, e.g. "sha256:...") this
#        deploy/rollback targeted. Empty string skips ONLY the digest
#        half of the check (with a warning) — used when the caller
#        genuinely has no target digest to compare against (e.g. very old
#        rollback state predating digest tracking); the StartedAt half
#        always runs regardless, since it needs no prior state at all.
#   $3 = epoch seconds this deploy/rollback began (StartedAt must be >=
#        this).
# Returns 0 if genuinely restarted and verified, 1 otherwise. Always
# prints a human-readable report either way — callers that need the
# verified digest/revision/StartedAt afterward can just call
# current_image_digest/current_image_revision <service> again, since by
# definition nothing changes between this returning 0 and that call.
verify_container_restarted() {
  local service="$1" expected_digest="$2" op_start_epoch="$3"
  local cid actual_digest revision started_at started_epoch ok=1
  cid="$(cd "$APP_DIR" && $COMPOSE ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$cid" ]]; then
    err "No running container found for '$service' after restart."
    return 1
  fi
  actual_digest="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)"
  revision="$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$cid" 2>/dev/null || true)"
  started_at="$(docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null || true)"
  started_epoch="$(_epoch_of "$started_at")"

  if [[ -n "$expected_digest" ]]; then
    if [[ "$actual_digest" != "$expected_digest" ]]; then
      err "'$service' is running image digest ${actual_digest:-<none>}, not the digest this operation targeted (${expected_digest})."
      err "'docker compose up -d' did not actually restart '$service' — this almost always means the target image's digest is unchanged from what was already running (nothing new to deploy, or a stale registry tag)."
      ok=0
    fi
  else
    warn "No target digest available to verify '$service' against — checking StartedAt only."
  fi

  if [[ "$started_epoch" -lt "$op_start_epoch" ]]; then
    err "'$service' container's StartedAt ($started_at) is BEFORE this operation began — it was never actually restarted, it's the same process that was already running."
    ok=0
  fi

  if [[ "$ok" == "1" ]]; then
    log "Verified '$service': digest ${actual_digest} (commit ${revision:-unknown}), started ${started_at} — genuinely restarted by this operation."
    return 0
  fi
  return 1
}

# Short git commit hash of the checkout deploy.sh is running from, or
# "unknown" outside a git checkout (shouldn't happen in production, but
# state-tracking should never crash over it).
current_git_commit() {
  (cd "$APP_DIR" && git rev-parse --short HEAD 2>/dev/null) || echo "unknown"
}

# Real health verification — same checks install-production.sh runs after
# first boot, reused here so deploy.sh/rollback.sh/status.sh all agree on
# what "healthy" means instead of three slightly different definitions.
# Returns 0 if healthy, 1 otherwise; prints a human-readable report either way.
run_health_checks() {
  require_env_file
  cd "$APP_DIR" || die "Could not cd into $APP_DIR"
  local ok=1

  for svc in traefik app worker redis; do
    local cid state
    cid="$($COMPOSE ps -q "$svc" 2>/dev/null || true)"
    if [[ -z "$cid" ]]; then
      err "Container for '$svc' is not running."
      ok=0
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
    if [[ "$state" != "running" ]]; then
      err "'$svc' is in state '$state', not 'running'."
      ok=0
    else
      log "'$svc' is running."
    fi
  done

  if $COMPOSE exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    log "Redis responds to PING."
  else
    err "Redis did not respond to PING."
    ok=0
  fi

  local tries=0
  until $COMPOSE exec -T app wget -qO- http://localhost:4000/api/health/live >/dev/null 2>&1; do
    tries=$((tries + 1))
    [[ $tries -ge 20 ]] && { err "App did not report healthy internally after 60s."; ok=0; break; }
    sleep 3
  done
  [[ $tries -lt 20 ]] && log "App liveness check passed internally."

  if [[ -n "${DOMAIN_NAME:-}" ]]; then
    # Patient retry (up to 100s): first-ever cert issuance via Let's
    # Encrypt's HTTP challenge can genuinely take a minute or two: DNS
    # propagation. Applies uniformly here — used by installer, deploy,
    # and rollback alike — rather than three different timeout budgets.
    local https_tries=0 https_ok=0
    until [[ $https_tries -ge 20 ]]; do
      if curl -fsS -o /dev/null "https://${DOMAIN_NAME}/api/health/live" 2>/dev/null; then
        https_ok=1
        break
      fi
      https_tries=$((https_tries + 1))
      sleep 5
    done
    if [[ $https_ok -eq 1 ]]; then
      log "https://${DOMAIN_NAME}/api/health/live responded successfully."
    else
      warn "https://${DOMAIN_NAME}/api/health/live did not respond after ~100s. If this is a fresh install, this can mean DNS hasn't propagated yet (Let's Encrypt's HTTP challenge needs ${DOMAIN_NAME} to already resolve to this VPS's IP) — see 'DNS REQUIRED' in PRODUCTION_DEPLOYMENT.md. Otherwise check ./logs.sh traefik."
      ok=0
    fi
  fi

  return $((1 - ok))
}
