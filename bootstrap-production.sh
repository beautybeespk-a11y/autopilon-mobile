#!/usr/bin/env bash
# bootstrap-production.sh — the ONE command for a fresh VPS.
#
#   curl -fsSL <raw-url-to-this-file> | sudo bash
#
# This file is intentionally tiny and does almost nothing itself — it
# only clones the repository to /opt/autopilon and hands off to
# install-production.sh, which is the real, fully-inspectable installer
# that lives in the repo (see that file for everything that actually
# happens: Ubuntu prep, Docker, firewall, Traefik/HTTPS, environment
# configuration, health checks). Keeping this wrapper minimal means:
#   - there's almost nothing here you have to trust sight-unseen from a
#     `curl | bash` — the substantial logic is a normal file in the repo
#     you can read (or clone yourself first — see the "inspect first"
#     option in VPS_SETUP.md) before it runs;
#   - re-running the installer later (or upgrading it) just means
#     `git pull`, no re-fetch of this bootstrap needed.
#
# Safe to re-run: if /opt/autopilon already exists and is a clone of this
# repository, it's updated in place (git fetch + reset to the target
# branch) rather than re-cloned — nothing under it that isn't tracked by
# git (the .env file, the backups/ directory, Docker's own named volumes)
# is touched.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/beautybeespk-a11y/autopilon-mobile.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/autopilon}"

C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'; C_RED='\033[31m'
log() { printf "${C_BOLD}${C_GREEN}==>${C_RESET} %s\n" "$1"; }
die() { printf "${C_BOLD}${C_RED}ERROR:${C_RESET} %s\n" "$1" >&2; exit 1; }

# Re-exec under sudo if not already root — curl|bash as a non-root user
# is common, and the real installer needs root for apt/docker/ufw.
if [[ $EUID -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    log "Not running as root — re-running under sudo (you may be prompted for your password)."
    exec sudo -E bash "$0" "$@"
  else
    die "Run this as root: sudo bash $0"
  fi
fi

if ! command -v git >/dev/null 2>&1; then
  log "Installing git (required to fetch the application)..."
  apt-get update -y -qq && apt-get install -y -qq git
fi

if [[ -d "$APP_DIR/.git" ]]; then
  log "Existing clone found at $APP_DIR — updating it (git pull), not re-cloning."
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
elif [[ -e "$APP_DIR" ]]; then
  die "$APP_DIR already exists and isn't a git clone of this repository. Move it aside or set APP_DIR to a different path (APP_DIR=/opt/autopilon2 sudo -E bash bootstrap-production.sh) before re-running — refusing to overwrite something that might be your data."
else
  log "Cloning $REPO_URL (branch: $BRANCH) to $APP_DIR..."
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

log "Handing off to install-production.sh..."
cd "$APP_DIR"
chmod +x install-production.sh deploy.sh rollback.sh backup.sh restore.sh status.sh logs.sh 2>/dev/null || true
exec ./install-production.sh
