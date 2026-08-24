# Backup Runbook (Phase 20)

How backups actually work in this deployment, exactly as implemented by
`backup.sh` / `restore.sh` (which themselves wrap the existing, already-
tested `server/scripts/backup-db.js` / `server/scripts/restore-db.js` from
Phase 18.6 — this document does not re-describe generic backup theory, it
describes what these specific scripts do).

## What gets backed up

Running `./backup.sh` (from `$APP_DIR`, e.g. `/opt/autopilon` on the VPS):

1. **Database** — `backup-db.js` runs inside the live `app` container,
   using `better-sqlite3`'s native online backup API (safe to run against
   a live, writing database — this is the same mechanism SQLite itself
   uses for `.backup`). Before it ever writes the final file, it runs
   `PRAGMA integrity_check` and a row-count comparison against the source
   database, and **throws rather than silently producing a corrupt
   backup**. Output: `backup-<UTC-timestamp>.sqlite.gz` (compressed).
2. **Uploaded files** — tarred from inside the `app` container (which
   already has the uploads volume mounted) and streamed straight to a host
   file — `uploads-<UTC-timestamp>.tar.gz`. If the uploads directory is
   empty (normal if the File Manager feature hasn't been used yet),
   `backup.sh` skips this with a warning instead of writing an empty
   archive.

## Where backups are stored

`$APP_DIR/backups` — e.g. `/opt/autopilon/backups` on the VPS. A plain
directory on the VPS's own local disk, created with `chmod 700` (root-only
readable). This directory is a bind mount into the `app` container (see
`docker-compose.prod.yml`), so `backup.sh`/`restore.sh` on the host and
`backup-db.js`/`restore-db.js` inside the container are reading/writing
the exact same files, not copies.

**⚠️ EXTERNAL ACTION REQUIRED — not yet configured.** This is backup
*creation*, not off-box *retention*. `/opt/autopilon/backups` lives on
the same disk as the running application — a full VPS disk failure,
accidental `rm -rf`, or the VPS itself being lost/deleted takes the
backups with it. Until an off-box destination is set up, treat local
backups as protection against *bad deploys and data mistakes*, not
against *VPS loss*. This does NOT block launch — it's a real risk to
carry consciously, not a blocker.

### Recommended: Backblaze B2 (cheapest realistic option)

Real, current pricing (checked at the time this was written): **$6/TB/month**
(i.e. $0.006/GB), with free egress up to 3x whatever you're storing —
[backblaze.com/cloud-storage/pricing](https://www.backblaze.com/cloud-storage/pricing).
At this app's actual current size — **~5.4 MB across all volumes**
combined (confirmed via `docker system df` on the real VPS) — even with
14x retention and a year of realistic growth, total off-box storage would
very likely stay under 1–2 GB, meaning **well under $0.01/month**. This
is effectively free at this project's current scale; re-evaluate the
number once real users are generating meaningful file uploads.

**Setup (🔐 EXTERNAL ACTION REQUIRED — you create the account, I can't):**
1. Create a free Backblaze account, then a B2 bucket (private) at
   backblaze.com. Note the bucket name and generate an **Application Key**
   scoped to only that bucket (not a master key) — Backblaze's own
   dashboard walks through this.
2. On the VPS, install `rclone` (a real, standard S3-compatible sync
   tool) and configure it with the key from step 1:
   ```bash
   sudo apt-get install -y rclone
   rclone config   # choose "b2", paste the Application Key ID/Key from step 1
   ```
3. Add to the same crontab, right after the backup job so it always runs
   on a completed backup, not a partial one:
   ```bash
   ( sudo crontab -l 2>/dev/null | grep -v '# autopilon-offbox' ; \
     echo "5 3 * * * rclone sync /opt/autopilon/backups b2:YOUR-BUCKET-NAME/autopilon-backups --min-age 5m >> /var/log/autopilon-offbox.log 2>&1 # autopilon-offbox" \
   ) | sudo crontab -
   ```
   (`--min-age 5m` skips anything backup.sh may still be writing —
   avoids syncing a partial file.)

### Simpler alternative: a second small VPS/storage box + rsync

If you'd rather not learn a new tool: any second cheap VPS or storage box
(Hostinger, or literally anywhere else — a few dollars/month) with SSH
access works as a destination, using tools already on the VPS:

```bash
# one-time: generate a dedicated key, copy the public half to the backup host
ssh-keygen -t ed25519 -f /root/.ssh/autopilon-backup -N ""
ssh-copy-id -i /root/.ssh/autopilon-backup.pub user@your-backup-host

# cron entry
( sudo crontab -l 2>/dev/null | grep -v '# autopilon-offbox' ; \
  echo "5 3 * * * rsync -az -e 'ssh -i /root/.ssh/autopilon-backup' --delete /opt/autopilon/backups/ user@your-backup-host:/backups/autopilon/ >> /var/log/autopilon-offbox.log 2>&1 # autopilon-offbox" \
) | sudo crontab -
```

**🔐 EXTERNAL ACTION REQUIRED either way**: whichever option you pick
needs a real external account/host you set up yourself — I cannot
provision or pay for either. Recommendation: Backblaze B2, since it's
purpose-built for this, has no ongoing server to maintain, and costs
effectively nothing at this project's current data volume.

## Automatic scheduling

`backup.sh` itself does not self-schedule — Phase 20 deliberately makes
no assumption about which scheduler you'd want. Install the cron entry
with this one-liner, run once as root on the VPS — it's idempotent (safe
to run again; it replaces any prior Autopilon backup entry by its marker
comment instead of duplicating it), and appends to whatever else is
already in root's crontab rather than requiring you to hand-edit it:

```bash
( sudo crontab -l 2>/dev/null | grep -v '# autopilon-backup' ; \
  echo "0 3 * * * cd /opt/autopilon && ./backup.sh >> /var/log/autopilon-backup.log 2>&1 # autopilon-backup" \
) | sudo crontab -
```

Verify it installed correctly:
```bash
sudo crontab -l | grep autopilon-backup
```

This runs daily at 03:00 UTC. Equivalent to adding this line via
`sudo crontab -e` by hand, if you prefer:

```cron
# Autopilon: daily database + uploads backup at 03:00 UTC
0 3 * * * cd /opt/autopilon && ./backup.sh >> /var/log/autopilon-backup.log 2>&1
```

**Errors are detectable two ways**: `/var/log/autopilon-backup.log` holds
every run's real output (grep it for `ERROR:`), and `set -euo pipefail`
at the top of `backup.sh` means any real failure — a bad write, a failed
integrity check — exits non-zero and stops there rather than silently
continuing; cron itself emails root on a non-zero exit if the VPS has a
local MTA configured (most don't by default — the log file is the
reliable signal either way). `./status.sh`'s "Most recent backup" line is
the fastest at-a-glance check that scheduled runs are actually happening.

To also encrypt every scheduled backup, you'd need `./backup.sh --encrypt`
to run non-interactively, which means the passphrase can't come from a
hidden prompt (there's no terminal in a cron job). Two real options if you
want encrypted *scheduled* backups:

- Run `./backup.sh` unencrypted on the schedule above, and separately
  encrypt/copy the files off-box in whatever process handles the off-box
  transfer (e.g. `gpg`/`openssl` as part of the `rsync` step, using a key
  file readable only by root — not typed interactively).
- Leave scheduled backups unencrypted on local disk (mode 700, root-only)
  and rely on VPS-level disk encryption + access control instead, if that
  meets your threat model.

Encrypting interactively (`./backup.sh --encrypt`, passphrase typed at a
real terminal) remains the right choice for a manual, ad-hoc backup you're
about to copy somewhere less trusted.

## Retention

Each backup type (`backup-*.sqlite.gz`, `backup-*.sqlite.gz.enc`,
`uploads-*.tar.gz`, `uploads-*.tar.gz.enc`) is retained independently, most
recent `BACKUP_RETAIN_COUNT` files (default **14**), pruned automatically
at the end of every `./backup.sh` run. Override by exporting
`BACKUP_RETAIN_COUNT` before running (or add it to `.env` and it'll be
picked up via `require_env_file`'s `source`).

Filenames are timestamped (`date -u +%Y%m%dT%H%M%SZ`), so concurrent or
repeated runs never overwrite each other — there is no "latest.sqlite.gz"
style filename anywhere in this system that a second backup run could
clobber.

## Verifying a backup was actually created

`backup.sh` does this itself, every run, automatically — it is not a
separate manual step:

- After calling `backup-db.js`, it searches `$BACKUP_DIR` for a matching
  `backup-*.sqlite.gz` file modified in the last 2 minutes and **dies**
  if none is found, even if `backup-db.js` exited 0 — protects against a
  backup that "succeeded" but didn't land where expected.
- At the end of the run, it runs `gzip -t` on the (unencrypted) database
  archive and **dies** if that fails — catches a truncated/corrupt write
  (e.g. the VPS disk filled up mid-backup) instead of silently trusting a
  broken file. Encrypted backups skip this specific re-check (would need
  the passphrase again) but rely on `backup-db.js`'s own
  `integrity_check` + row-count verification, which already ran before
  encryption.
- Every run ends by printing `ls -lh` of the backups directory, so the
  result is visible immediately, not just logged.

To check *after the fact* that scheduled backups are actually happening
(not just that the last one succeeded), run `./status.sh` — its "Most
recent backup" section shows the newest `backup-*.sqlite.gz` file found on
disk and its timestamp. If that timestamp is older than your cron
schedule implies it should be, the cron job itself has stopped running —
check `/var/log/autopilon-backup.log` and `sudo crontab -l`.

## Restoring

```bash
./restore.sh backup-20260115T030000Z.sqlite.gz     # restore the database
./restore.sh uploads-20260115T030000Z.tar.gz        # restore uploaded files
./restore.sh backup-20260115T030000Z.sqlite.gz.enc  # encrypted — prompts for the passphrase
./restore.sh <file> --yes                           # skip the confirmation prompt
```

Accepts a bare filename (looked up in `./backups`) or a full path.
Restore kind (`database` vs `uploads`) is auto-detected from the filename
pattern.

What actually happens, in order:

1. If the file ends in `.enc`, prompts for the decryption passphrase
   (hidden input, never logged) and decrypts to a temp file that is
   removed automatically when the script exits (`trap ... EXIT`), success
   or failure.
2. Shows exactly what will happen and asks for confirmation (skip with
   `--yes` — useful for scripted/emergency restores).
3. Stops the `app` and `worker` containers. **Redis and Traefik keep
   running** — the domain stays resolvable throughout (visitors see a
   connection error rather than a DNS failure), and this is typically well
   under a minute end-to-end.
4. **Database restore**: runs the existing, unmodified `restore-db.js`
   inside a one-off container (`docker compose run`, not `exec`, since
   `app` is stopped). `restore-db.js` makes its own timestamped safety
   copy of the *current* database before overwriting it, and verifies the
   incoming backup before committing to the swap — so a bad restore
   decision is itself reversible, and a corrupt backup file is rejected
   before it can replace a working database. If it fails, `restore.sh`
   restarts `app`/`worker` on the untouched existing database and exits
   non-zero — you are never left with both containers down and no
   database.
5. **Uploads restore**: saves a timestamped safety tarball of the
   *current* uploads directory first (via a one-off container), then
   extracts the backup over `/app/server/uploads`.
6. Restarts `app` + `worker`, then runs the same real health checks every
   other script uses (`_common.sh`'s `run_health_checks`) — containers up,
   Redis responding, `/api/health/live` responding both internally and
   over HTTPS.

If health checks fail after a restore, `restore.sh` exits non-zero and
tells you to check `./logs.sh app` / `./logs.sh worker` — it does not
attempt an automatic second rollback of the restore itself (the pre-
restore safety copies described above are how you'd manually recover if
needed: they're timestamped files sitting in `./backups` alongside
everything else).

## Preventing accidental overwrite

- Every backup filename includes a UTC timestamp — no fixed filename is
  ever reused, so running `./backup.sh` twice never destroys an earlier
  backup.
- Every restore first writes a fresh, timestamped safety copy of whatever
  it's about to replace (current database via `restore-db.js`'s own
  logic; current uploads via `restore.sh`'s own step) — so a restore that
  turns out to be the wrong choice is itself recoverable from the backups
  directory.
- Retention pruning only ever deletes files older than the newest
  `BACKUP_RETAIN_COUNT`, and only within each specific artifact-type
  pattern — it cannot cross-delete database backups while pruning uploads
  or vice versa.

## Related

- `PRODUCTION_DEPLOYMENT.md` — overall architecture, security posture.
- `VPS_SETUP.md` — initial installation.
- `server/scripts/backup-db.js` / `server/scripts/restore-db.js` — the
  underlying, unmodified Phase 18.6 implementations `backup.sh`/
  `restore.sh` drive.
