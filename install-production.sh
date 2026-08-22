#!/usr/bin/env bash
# install-production.sh — Phase 20 production installer.
#
# Idempotent: safe to re-run. Never destroys the database, uploads, or
# Redis data volumes. Reuses the existing, already-tested architecture
# (Phase 16-19) — this script provisions infrastructure around it
# (Ubuntu, Docker, firewall, Traefik/HTTPS, .env, backups), it does not
# change how the application itself works.
#
# Run this from INSIDE a clone of the repository (bootstrap-production.sh
# does that for you, or clone it yourself and run this directly — see
# VPS_SETUP.md for both paths). Must be run as root (or via sudo).
#
#   sudo ./install-production.sh
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Guards + small helpers
# ---------------------------------------------------------------------------

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run this as root (sudo ./install-production.sh) — Docker, ufw, and system package installation all need root." >&2
  exit 1
fi

if [[ ! -f "$_SCRIPT_DIR/docker-compose.yml" || ! -f "$_SCRIPT_DIR/docker-compose.prod.yml" || ! -f "$_SCRIPT_DIR/_common.sh" ]]; then
  echo "ERROR: docker-compose.yml / docker-compose.prod.yml / _common.sh not found next to this script — run install-production.sh from inside the cloned repository, not by itself." >&2
  exit 1
fi

# shellcheck source=_common.sh
source "$_SCRIPT_DIR/_common.sh"
cd "$APP_DIR"
# prompt(), prompt_secret(), prompt_yn(), log()/warn()/err()/die() all
# come from _common.sh — see that file, kept here once instead of
# duplicated across every script that needs them.

echo
echo "=============================================================="
echo " Autopilon — Production Installer (Phase 20)"
echo " Application dir: $APP_DIR"
echo "=============================================================="
echo

# ---------------------------------------------------------------------------
# 1. Prepare Ubuntu
# ---------------------------------------------------------------------------
step_prepare_ubuntu() {
  log "1/9 Preparing Ubuntu (package updates, base dependencies, timezone, automatic security updates)"

  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    if [[ "${ID:-}" != "ubuntu" ]]; then
      warn "This installer targets Ubuntu (tested against 24.04 LTS) — detected ID=${ID:-unknown}. Continuing, but expect rough edges on a different distro."
    fi
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get upgrade -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git ufw unattended-upgrades openssl jq apt-transport-https

  # UTC is the sane, unambiguous default for a server — every log line,
  # backup timestamp, and cert-expiry check this app produces is easiest
  # to reason about in one fixed timezone. Change later with
  # `timedatectl set-timezone <Region/City>` if you'd rather see local
  # time in `date`/`timedatectl status` — nothing in the application
  # depends on the OS timezone (it timestamps everything in UTC/ISO 8601
  # internally regardless).
  timedatectl set-timezone UTC || warn "Could not set timezone (non-fatal, continuing)."

  # Security updates only, no automatic reboot — a surprise reboot of a
  # live single-instance VPS is worse than a delayed security patch. See
  # VPS_SETUP.md for how to opt into automatic reboots if you want them.
  cat > /etc/apt/apt.conf.d/51unattended-upgrades-autopilon <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF
  systemctl enable --now unattended-upgrades || warn "Could not enable unattended-upgrades (non-fatal)."

  log "Ubuntu prepared."
}

# ---------------------------------------------------------------------------
# 2. Configure Docker
# ---------------------------------------------------------------------------
step_install_docker() {
  log "2/9 Installing/verifying Docker Engine + Docker Compose plugin"

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + Compose plugin already installed ($(docker --version)); skipping install."
  else
    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
    fi
    . /etc/os-release
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME:-noble} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  systemctl enable --now docker

  log "Verifying Docker actually works before continuing..."
  if ! docker run --rm hello-world >/dev/null 2>&1; then
    die "Docker was installed but 'docker run hello-world' failed — check 'systemctl status docker' and 'journalctl -u docker' before re-running this installer."
  fi
  log "Docker verified working ($(docker --version), $(docker compose version --short 2>/dev/null || docker compose version))."
}

# ---------------------------------------------------------------------------
# 3. Configure firewall
# ---------------------------------------------------------------------------
step_configure_firewall() {
  log "3/9 Configuring firewall (ufw) — only 22/80/443 will be reachable from the internet"

  # Safety first: explicitly allow SSH BEFORE default-deny is enabled, and
  # verify the rule is actually staged, so a mistake here can never lock
  # you out. Uses the named "OpenSSH" profile when available (tracks
  # whatever port sshd is actually configured for) and also explicitly
  # allows 22/tcp as a fallback so a non-standard OpenSSH app profile
  # can't silently miss the real port.
  ufw allow OpenSSH || true
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp

  # NOTE: "ufw status" only lists rules once ufw is active — before that it
  # just prints "Status: inactive" with no rule detail, even with rules
  # already staged. "ufw show added" lists staged rules regardless of
  # active state, which is what we actually need to check here.
  if ! ufw show added | grep -qE '22(/tcp)?$|allow 22'; then
    die "Refusing to enable the firewall — could not confirm an SSH-allow rule was staged. Your current SSH session is safe (ufw isn't enabled yet); fix this manually (ufw allow 22/tcp) before re-running."
  fi

  ufw default deny incoming
  ufw default allow outgoing
  ufw --force enable

  log "Firewall active. Redis, the app's internal port, and Docker's own management surface are never published to the host — see docker-compose.prod.yml (no host ports on redis/app; only Traefik publishes 80/443)."
  ufw status verbose || true
}

# ---------------------------------------------------------------------------
# 4/5. Collect configuration -> .env  (application install + env vars)
# ---------------------------------------------------------------------------
step_collect_configuration() {
  log "4/9 + 5/9 Application setup and environment configuration"

  if [[ -f "$ENV_FILE" ]]; then
    if prompt_yn "An existing .env was found at $ENV_FILE — reuse it as-is?" y; then
      log "Reusing existing .env. Delete it and re-run this installer if you want to reconfigure from scratch."
      require_env_file
      return
    fi
    cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"
    warn "Backed up the previous .env before overwriting it."
  fi

  echo
  echo "---- Required configuration ----"
  echo "Nothing you enter here is ever sent anywhere except into a local,"
  echo "root-only-readable .env file on THIS machine (not git, not logs,"
  echo "not the Docker image)."
  echo

  prompt DOMAIN_NAME "Domain name this app will be reachable at (e.g. app.example.com)"
  [[ -n "$DOMAIN_NAME" ]] || die "A domain name is required — Traefik/Let's Encrypt cannot request a certificate without one."

  prompt ACME_EMAIL "Email for Let's Encrypt certificate notifications (expiry warnings, not spam)"
  [[ "$ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "That doesn't look like a valid email — Let's Encrypt requires one."

  prompt PLATFORM_ADMIN_EMAIL "Email that should become the platform admin (Admin Panel access) on first signup" "$ACME_EMAIL"

  echo
  echo "AI provider — required. Every agent execution/chat message needs this."
  prompt AI_PROVIDER "AI provider (anthropic | openai | gemini)" "anthropic"
  case "$AI_PROVIDER" in
    anthropic) prompt_secret ANTHROPIC_API_KEY "Anthropic API key" ;;
    openai)    prompt_secret OPENAI_API_KEY "OpenAI API key" ;;
    gemini)    prompt_secret GEMINI_API_KEY "Gemini API key" ;;
    *) die "AI_PROVIDER must be one of: anthropic, openai, gemini" ;;
  esac

  echo
  if prompt_yn "Configure Stripe billing now? (optional — skip and add later by editing .env)" n; then
    prompt_secret STRIPE_SECRET_KEY "Stripe secret key"
    prompt_secret STRIPE_WEBHOOK_SECRET "Stripe webhook signing secret"
  fi

  echo
  if prompt_yn "Configure Google OAuth (Gmail/Calendar/Drive/Docs/Sheets) now? (optional)" n; then
    prompt GOOGLE_CLIENT_ID "Google OAuth client ID"
    prompt_secret GOOGLE_CLIENT_SECRET "Google OAuth client secret"
    GOOGLE_REDIRECT_URI="https://${DOMAIN_NAME}/api/integrations/gmail/callback"
    log "GOOGLE_REDIRECT_URI set to $GOOGLE_REDIRECT_URI — register this exact URI in Google Cloud Console."
  fi

  echo
  if prompt_yn "Configure Meta OAuth (Ads/WhatsApp) now? (optional)" n; then
    prompt META_APP_ID "Meta app ID"
    prompt_secret META_APP_SECRET "Meta app secret"
    META_REDIRECT_URI="https://${DOMAIN_NAME}/api/integrations/meta/callback"
    log "META_REDIRECT_URI set to $META_REDIRECT_URI — register this exact URI in your Meta developer app."
  fi

  # Opaque secrets — deliberately never prompted for. A human-chosen value
  # here is strictly worse than a real random one; generated fresh every
  # time this branch runs (only on first setup or explicit reconfigure).
  SESSION_SECRET="$(openssl rand -hex 32)"
  BYOK_ENCRYPTION_KEY="$(openssl rand -hex 32)"

  IMAGE_REPO="ghcr.io/beautybeespk-a11y/autopilon-mobile"
  prompt IMAGE_TAG "Image tag to deploy (latest = most recent main-branch build)" "latest"

  umask 077
  {
    echo "# Generated by install-production.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Never commit this file."
    echo "NODE_ENV=production"
    echo "DOMAIN_NAME=$DOMAIN_NAME"
    echo "ACME_EMAIL=$ACME_EMAIL"
    echo "CLIENT_ORIGIN=https://$DOMAIN_NAME"
    echo "APP_BASE_URL=https://$DOMAIN_NAME"
    echo "PLATFORM_ADMIN_EMAIL=$PLATFORM_ADMIN_EMAIL"
    echo "SESSION_SECRET=$SESSION_SECRET"
    echo "BYOK_ENCRYPTION_KEY=$BYOK_ENCRYPTION_KEY"
    echo "AI_PROVIDER=$AI_PROVIDER"
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    [[ -n "${OPENAI_API_KEY:-}" ]] && echo "OPENAI_API_KEY=$OPENAI_API_KEY"
    [[ -n "${GEMINI_API_KEY:-}" ]] && echo "GEMINI_API_KEY=$GEMINI_API_KEY"
    [[ -n "${STRIPE_SECRET_KEY:-}" ]] && echo "STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY"
    [[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]] && echo "STRIPE_WEBHOOK_SECRET=$STRIPE_WEBHOOK_SECRET"
    [[ -n "${GOOGLE_CLIENT_ID:-}" ]] && echo "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID"
    [[ -n "${GOOGLE_CLIENT_SECRET:-}" ]] && echo "GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET"
    [[ -n "${GOOGLE_REDIRECT_URI:-}" ]] && echo "GOOGLE_REDIRECT_URI=$GOOGLE_REDIRECT_URI"
    [[ -n "${META_APP_ID:-}" ]] && echo "META_APP_ID=$META_APP_ID"
    [[ -n "${META_APP_SECRET:-}" ]] && echo "META_APP_SECRET=$META_APP_SECRET"
    [[ -n "${META_REDIRECT_URI:-}" ]] && echo "META_REDIRECT_URI=$META_REDIRECT_URI"
    echo "STORAGE_PROVIDER=local"
    echo "IMAGE_REPO=$IMAGE_REPO"
    echo "IMAGE_TAG=$IMAGE_TAG"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  log ".env written to $ENV_FILE (mode 600, root-owned). See .env.example in this repo for every OTHER optional variable (search providers, STT/TTS, WhatsApp, Shopify, Firebase push, S3 storage) — add any of those the same way, by editing this file directly, then re-run ./deploy.sh to pick them up."
}

# ---------------------------------------------------------------------------
# 6. Registry access for the pre-built image
# ---------------------------------------------------------------------------
step_registry_access() {
  log "6/9 Checking access to the pre-built application image"
  require_env_file

  if docker pull "${IMAGE_REPO}:${IMAGE_TAG}" >/dev/null 2>&1; then
    log "Pulled ${IMAGE_REPO}:${IMAGE_TAG} successfully — GitHub Container Registry access confirmed."
    USE_PREBUILT_IMAGE=1
    return
  fi

  warn "Could not pull ${IMAGE_REPO}:${IMAGE_TAG} without authentication."
  echo "This is expected the very first time — GitHub Container Registry packages"
  echo "default to private even when the repository is public. Two options:"
  echo
  echo "  A) RECOMMENDED — make the package public (one-time, on GitHub):"
  echo "     github.com/beautybeespk-a11y/autopilon-mobile/pkgs/container/autopilon-mobile"
  echo "     → Package settings → Change visibility → Public"
  echo "     Then re-run this installer, or just: $COMPOSE pull"
  echo
  echo "  B) Authenticate this VPS with a GitHub Personal Access Token"
  echo "     (classic, 'read:packages' scope only — not a broader token)."
  echo

  if prompt_yn "Authenticate now with a PAT? (No = fall back to building the image on this VPS instead)" n; then
    prompt GHCR_USERNAME "Your GitHub username"
    prompt_secret GHCR_TOKEN "Personal Access Token (read:packages scope, input hidden)"
    if echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin; then
      log "Logged in to ghcr.io. Note: this credential is stored by Docker's own credential store (~/.docker/config.json on this VPS), not in this repo or in .env."
      USE_PREBUILT_IMAGE=1
    else
      warn "Login failed — falling back to an on-VPS build."
      USE_PREBUILT_IMAGE=0
    fi
  else
    USE_PREBUILT_IMAGE=0
  fi
}

# ---------------------------------------------------------------------------
# 7. Start the stack
# ---------------------------------------------------------------------------
step_start_stack() {
  log "7/9 Starting the application stack (Traefik + app + worker + Redis)"
  cd "$APP_DIR"

  if [[ "${USE_PREBUILT_IMAGE:-0}" == "1" ]]; then
    $COMPOSE pull || warn "Pull failed for one or more images — continuing, compose will build what it can."
  else
    warn "No pre-built image available — building on this VPS instead (slower, real work: npm ci + client build + native module compile). This is the same, already-tested build the existing Dockerfile/docker-compose.yml define — just running here instead of in CI."
    $COMPOSE build
  fi

  $COMPOSE up -d --remove-orphans
  log "Stack started. Waiting for containers to report healthy..."
}

# ---------------------------------------------------------------------------
# 8. Health checks
# ---------------------------------------------------------------------------
step_health_checks() {
  log "8/9 Running health checks"
  echo "-- Docker container status --"
  $COMPOSE ps
  echo

  if run_health_checks; then
    log "All health checks passed."
  else
    warn "One or more health checks did not pass — see the messages above. The stack is still running; this is diagnostic, not a rollback trigger. Certificate issuance can genuinely take a minute or two on a first boot — if only the HTTPS check failed, wait a bit and re-check: curl -v https://\${DOMAIN_NAME}/api/health/live"
  fi
}

# ---------------------------------------------------------------------------
# 9. Summary
# ---------------------------------------------------------------------------
step_summary() {
  require_env_file
  echo
  echo "=============================================================="
  echo " Installation complete."
  echo "=============================================================="
  echo " App:          https://${DOMAIN_NAME}"
  echo " Health:       https://${DOMAIN_NAME}/api/health/live"
  echo " Compose file: docker-compose.yml + docker-compose.prod.yml"
  echo " .env:         $ENV_FILE (mode 600 — back this up somewhere safe, it is NOT in git)"
  echo
  echo " Useful commands (from $APP_DIR):"
  echo "   ./status.sh     — current health/resource snapshot"
  echo "   ./logs.sh app   — tail a service's logs"
  echo "   ./backup.sh     — run a backup now"
  echo "   ./deploy.sh     — pull + deploy a new image"
  echo "   ./rollback.sh   — revert to the previous deployed image"
  echo "=============================================================="
}

# ---------------------------------------------------------------------------
main() {
  step_prepare_ubuntu
  step_install_docker
  step_configure_firewall
  step_collect_configuration
  step_registry_access
  step_start_stack
  step_health_checks
  step_summary
}

main "$@"
