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

# Returns the exact image reference (repo:tag) the `app` container is
# CURRENTLY running, straight from Docker — not from .env, which could be
# stale relative to what's actually deployed.
current_running_image() {
  local cid
  cid="$(cd "$APP_DIR" && $COMPOSE ps -q app 2>/dev/null || true)"
  [[ -n "$cid" ]] || { echo ""; return; }
  docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || echo ""
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
