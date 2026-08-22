# VPS Setup (Phase 20)

Getting a fresh Ubuntu 24.04 VPS (this was written for a Hostinger KVM 2 —
2 vCPU / 8 GB RAM / 100 GB NVMe — but nothing here is Hostinger-specific)
to a running, HTTPS-secured deployment of this application.

This document is the concrete "do this" companion to
`DEPLOYMENT_RUNBOOK.md` (generic procedures, written before a real VPS
existed) and `EXTERNAL_INFRASTRUCTURE.md` (what external accounts/services
are needed and why). Read `PRODUCTION_DEPLOYMENT.md` for how the pieces
fit together architecturally; this doc is just the setup steps.

## Before you start

You need, ready in hand:

- **SSH access to the VPS** as root (or a sudo-capable user).
- **A domain name** you control, with the ability to add DNS records (see
  "DNS records" below) — the installer will ask for this.
- **At least one real AI provider API key** (Anthropic, OpenAI, or
  Gemini) — the installer will ask for this too. Nothing in this app
  works without one.
- Optionally ready (the installer lets you skip any of these and add them
  later by editing `.env` and running `./deploy.sh`): Stripe keys, Google/
  Meta OAuth app credentials.

## DNS records required

Point your domain at the VPS's public IP address **before** running the
installer — Let's Encrypt's HTTP challenge needs `your-domain.com` to
already resolve to this server, or certificate issuance will fail (the
installer's health check will tell you clearly if this happens, and it's
safe to just fix DNS and re-run `./deploy.sh` afterward — nothing is
lost).

```
Type    Name    Value
A       @       <your VPS's public IPv4 address>
A       www     <your VPS's public IPv4 address>
```

That's it — only these two records are actually required. No MX, no TXT,
no CAA record is needed for this deployment (Let's Encrypt's HTTP
challenge doesn't require a CAA record; add one later if you want to
explicitly restrict which CAs can issue for your domain, but it's not
required to get HTTPS working).

DNS propagation can take anywhere from a few minutes to a few hours
depending on your registrar/DNS provider and the record's TTL.

## Option A — one-command install (recommended)

SSH into the fresh VPS as root, then:

```bash
curl -fsSL https://raw.githubusercontent.com/beautybeespk-a11y/autopilon-mobile/main/bootstrap-production.sh | sudo bash
```

*(If this repository's default branch isn't `main` yet — e.g. this work
is still on a feature branch — replace `main` in the URL with the actual
branch name. See the "ONE-COMMAND VPS SETUP" section of the final Phase
20 report for the exact currently-correct URL.)*

This clones the repository to `/opt/autopilon` and runs
`install-production.sh` from inside it. You'll be prompted for your
domain, an email for Let's Encrypt, and your AI provider key (see
"SECRETS REQUIRED" in `PRODUCTION_DEPLOYMENT.md` for the full list of
what you'll be asked for and why) — nothing you type is echoed back,
logged, or sent anywhere except into a local `.env` file on the VPS
itself.

## Option B — download and inspect first

If you'd rather read the script before running it as root (reasonable —
this is exactly what `curl | bash` skeptics should do):

```bash
wget https://raw.githubusercontent.com/beautybeespk-a11y/autopilon-mobile/main/bootstrap-production.sh
less bootstrap-production.sh          # read it
chmod +x bootstrap-production.sh
sudo ./bootstrap-production.sh
```

`bootstrap-production.sh` is deliberately tiny — it only clones the repo
and hands off to `install-production.sh`, which is the file doing
everything substantial. Once cloned, you can read that one too before
it runs:

```bash
git clone https://github.com/beautybeespk-a11y/autopilon-mobile.git /opt/autopilon
cd /opt/autopilon
less install-production.sh            # read the real installer
sudo ./install-production.sh
```

Both options end up running the exact same `install-production.sh` — the
only difference is whether you fetch-and-run in one step or inspect the
clone first.

## What the installer actually does

In order (see `install-production.sh`'s own comments for the full detail
on each step):

1. **Prepare Ubuntu** — package updates, base dependencies (`curl`,
   `git`, `ufw`, `unattended-upgrades`, `openssl`, `jq`), timezone set to
   UTC, automatic security updates enabled (reboot NOT automatic — a
   surprise reboot of a live single-instance server is worse than a
   delayed patch; see "Automatic reboots" below if you want that).
2. **Install Docker** — Docker Engine + the Compose plugin via Docker's
   official apt repository, verified with a real `docker run
   hello-world` before continuing.
3. **Configure the firewall (ufw)** — allows only 22 (SSH), 80 (HTTP),
   443 (HTTPS). The SSH-allow rule is staged and verified **before**
   the firewall's default-deny is ever enabled, specifically so a mistake
   here cannot lock you out. Redis, the app's internal port, and Docker's
   own management surface are never exposed publicly — see
   `docker-compose.prod.yml`.
4. **Collect configuration** — interactive prompts, writes `/opt/autopilon/.env`
   (mode 600, root-only-readable, never committed to git).
5. **Registry access** — tries to pull the pre-built image from GitHub
   Container Registry; falls back to building on the VPS if that's not
   accessible yet (see "SECRETS REQUIRED" for the two ways to fix this
   permanently).
6. **Start the stack** — `docker compose -f docker-compose.yml -f
   docker-compose.prod.yml up -d`: Traefik, the app, the worker, Redis.
7. **Health checks** — containers running, Redis responding, the app's
   real `/api/health/live` endpoint responding both internally and over
   HTTPS through Traefik.

Safe to re-run: every step is idempotent (skips what's already done,
never destroys the database/uploads/Redis volumes, asks before
overwriting an existing `.env`).

## Automatic reboots (optional)

The installer enables automatic **security** updates but leaves automatic
**reboots** off. If you want reboots too (e.g. for kernel security
patches that need one to take effect):

```bash
echo 'Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";' | sudo tee -a /etc/apt/apt.conf.d/51unattended-upgrades-autopilon
```

## After installation

- `https://your-domain.com` — the app.
- `./status.sh` — a live snapshot (containers, health, Redis, disk,
  memory, cert expiry, most recent backup).
- Set up a recurring `./backup.sh` — see `BACKUP_RUNBOOK.md`, this is
  not automatic on a schedule by default (no assumption is made about
  which scheduler you want; a one-line cron entry is provided there).

## If something goes wrong during install

The installer prints clear `ERROR:`/`WARN:` lines and stops on a genuine
failure rather than continuing silently. Common first-run issues:

- **HTTPS health check fails, everything else passes** — almost always
  DNS hasn't propagated yet. Confirm with `dig +short your-domain.com`
  from your own machine (should return the VPS's IP); once it does,
  re-run `./deploy.sh` (or just wait — Traefik retries certificate
  issuance on its own).
- **"Could not pull ... without authentication"** — expected on a brand
  new repository before its first GitHub Actions build has run, or if the
  GHCR package hasn't been made public yet. See "SECRETS REQUIRED" in
  `PRODUCTION_DEPLOYMENT.md`.
- **Docker verification fails** — check `systemctl status docker` and
  `journalctl -u docker` on the VPS; re-run the installer once fixed.

For anything else: `./logs.sh <service>` (`traefik`, `app`, `worker`, or
`redis`) shows that container's real logs.
