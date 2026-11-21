# Atelier backup broker

`backupd.py` takes consistent backups of the live host, restores them, and starts a staging copy
from one. It runs as root on the host. OpenBot's **Server settings → Backups** talks to it over a
unix socket. Only OpenBot's Electron main process may use that socket: the broker checks the
caller's pid with SO_PEERCRED, so agents in the container get 403.

## What a backup holds

`/opt/openbot/backups/atelier/snapshots/<YYYY-MM-DD-HHMM>/`:

| Part | How |
| --- | --- |
| `openbot.db.zst` | SQLite online backup API, run as uid 1000. Checked with `integrity_check`, zstd-compressed (2.3 GB -> ~200 MB). Schema and per-table counts go in `manifest.json`. |
| `motion.db.zst` | The same for `/opt/motion/data/motion.db`, run as uid 10001. |
| `files/data/` (core) | All of `/opt/openbot/data` except caches, toolchains, provider runtimes, old `backups/`, and (by default) browser profiles. This covers every userData file (vault, agent-api-keys, keyring and its password, provider accounts in `.claude*`/`.codex`, every `openbot-*-v1.json`, trust policy and audit, transcripts). SQLite files in it are re-copied with the backup API. |
| `files/data/OpenBot/{Agents,Shared,Downloads}` | Agent workspaces. Skips `node_modules`, `target`, `.godot`, `__pycache__`, `.venv`, toolchains under `tools/`, and files over `max_file_mb` (50). |
| `files/data/OpenBot/Spaces/<space>` | One component per space, with the same filters. |
| `files/motion/` | Motion's `.env`, compose file, `data/files` and `data/sync`. |
| `files/host/` | `compose.yaml`, `.env.runtime`, `seccomp.json` and the remote/ configs. Kept for disaster recovery only; restore never writes them. |

rsync `--link-dest` hard-links unchanged files to the previous snapshot. A nightly backup therefore
costs the database (~200 MB) plus whatever changed. Before each workspace or space copy that has no
earlier copy, the broker estimates its size. If the copy would leave less than `min_free_gb` (20) on
the disk, that part is **skipped**, and the backup shows as "partial" with the reason.

**This host (2026-11-21):** Spaces hold 206 GB raw, about 70 GB after the filters (cakemaker 63 GB,
piks 19 GB, nergia ~20 GB) and 2.8M files. The disk has 55 GB free. The first nightly backup will
therefore take the database, core (~6.5 GB), workspaces and the small spaces, and skip the biggest
spaces until there is room. To back up fewer spaces, set `"spaces": ["general", ...]` in
`config.json`.

**Retention:** the newest nightly backup of each of the last 7 days and the last 4 weeks, the last
3 manual backups, the last 2 pre-restore safety copies, the copy that staging is using, and always
the newest good backup. Failed backups are removed after 2 days.

## Install (root; not done on this host yet)

```bash
cd /home/ubuntu/openbot-release-work/openbot-release        # after merging backup-staging-ops
sudo python3 -I scripts/backup-broker/backupd.py install
```

This copies the script to `/opt/openbot/backups/atelier/`, writes `config.json`, and enables
`atelier-backup.service` (the socket) and `atelier-backup-run.timer` (nightly at 03:30, plus up to 10
random minutes, `Persistent=true`). Then add one mount to the `openbot` service in
`/opt/openbot/compose.yaml` and do a normal deploy, which recreates the container:

```yaml
      - ./backups/atelier/client:/opt/backupctl:ro
```

The Backups section shows "not set up" until the socket is mounted.

## Commands

```bash
B="sudo python3 -I /opt/openbot/backups/atelier/backupd.py"
$B run --reason manual          # back up now (~1 min with the database alone; the Spaces scan adds minutes)
$B list                         # JSON: backups, running job, last restore, disk, staging
$B check <id> [--spaces]        # restore dry run: checksums, archive test, schema, row counts
$B restore <id> --confirm <id> [--spaces]
$B prune
journalctl -u atelier-backup-run -n 50     # the last nightly backup
journalctl -u 'atelier-restore-*'          # a restore started from the web
```

**A restore** takes a pre-restore safety backup first, then stops `openbot` (and `motion-server`).
It then puts back the database, core (with `--delete`, so files created after the backup go, but
caches stay), Motion, and the workspaces. Workspaces and spaces are restored **without** delete:
changed files go back to the backup's version, and newer files stay. Spaces are restored only with
`--spaces`, or with the matching checkbox in the web UI. Then it starts both services, waits for the
control socket, and checks the database. A failed step still restarts OpenBot. The safety backup's id
is in the result, for a roll-back with `restore`. The web UI asks you to type the backup name.

## Off-site copy (optional; no credentials exist on this host yet)

The broker uploads a gpg-encrypted (AES256) tar of the database, Motion and core settings (no
workspaces; transcripts only with `"offsite": {"include_transcripts": true}`). It uploads after each
backup to any S3-compatible store and keeps the newest `BACKUP_OFFSITE_KEEP` copies. Cloudflare R2
setup:

1. Cloudflare dashboard → R2 → Create bucket `atelier-backups`. Then R2 → Manage API tokens →
   Create token with **Object Read & Write** on that bucket only. Note the Access Key ID, the Secret,
   and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.
2. On the host:
   ```bash
   sudo install -m 600 /dev/stdin /opt/openbot/secrets/backup-offsite.env <<'EOF'
   BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   BACKUP_S3_BUCKET=atelier-backups
   BACKUP_S3_REGION=auto
   BACKUP_S3_ACCESS_KEY_ID=...
   BACKUP_S3_SECRET_ACCESS_KEY=...
   BACKUP_ENCRYPTION_PASSPHRASE=<long random; store it in your password manager too>
   BACKUP_OFFSITE_KEEP=14
   EOF
   sudo python3 -I /opt/openbot/backups/atelier/backupd.py offsite <newest id>   # first upload by hand
   ```
3. To restore from it: download the object, then
   `gpg -d atelier-<id>.tar.gpg | tar -x -C /opt/openbot/backups/atelier/snapshots/<id>`. Then run
   `check` and `restore` as usual.

## Staging copy

```bash
$B staging up [--from <id>] [--image openbot-private:main-xxxx] [--fresh-db] [--no-view]
$B staging status
$B staging down
```

`staging up` mounts an overlay: the backup's `files/data` is the read-only lower layer, and writes go
to `/opt/openbot/staging/upper`. It costs no disk until something changes, and the backup stays
untouched (it is pinned against pruning while staging runs). It then puts in the backup's database,
or with `--fresh-db` a fresh online copy of the live one. It starts `atelier-staging` (6 GB) with its
own display. The copy is made safe like this:

- an `internal: true` Docker network: no internet, so no provider, messaging, Signal or Motion traffic
- every provider switched off (`openbot-provider-use-v1.json`)
- its account session, server identity, messaging/Discord/GitHub/MCP sign-ins and provider sign-ins
  (`.claude/.credentials.json`, `.codex/auth.json`) removed: a token refresh from the copy can't
  sign the live host out
- the Signal and auth URLs replaced with `.invalid` hosts

You see it through noVNC at `http://127.0.0.1:20120/vnc.html`. From your PC:
`ssh -L 20120:127.0.0.1:20120 ubuntu@158.69.224.199`, then open that URL. The first `up` builds the
`atelier-staging-view:1` image (~1 min).

**staging.delynith.com (prepared, not created).** VNC has no password, so do these in this order:
1. Cloudflare Zero Trust → Access → Applications → Add a self-hosted app for
   `staging.delynith.com`, with a policy that allows only your email.
2. DNS: a proxied A record `staging` -> `158.69.224.199` (comment `atelier-staging`).
3. `sudo cp scripts/backup-broker/nginx-staging.conf /etc/nginx/conf.d/zz-staging.conf && sudo nginx -t && sudo systemctl reload nginx`
   (the existing `*.delynith.com` Origin certificate covers it).

## Deploy to staging first

`build-vps.sh fork/main --deploy --staging-first`, or
`python3 -I scripts/private-release-deploy.py <release> --existing-image --staging-first`.

After the isolated smoke test, and before the Worker or the host is touched, the new image opens a
fresh copy of the live database on the files of the newest backup. Its migration must keep integrity
ok, reach the expected schema, and keep every `projection_*` row count (unless `--allow-row-drop` is
given). A failure stops the deploy with the live host untouched. `--staging-only` stops after the
check and leaves the copy running. The default deploy path is unchanged. It needs the broker
installed and at least one backup.

## Tests

`scripts/backup-broker` was tested end to end on a throwaway host in the scratchpad: a copy of the
production DB snapshot, dummy config and workspace files, a Motion stand-in, and a test OpenBot
container with no network. The tests covered backup, retention, check, refused confirm, restore
(files reverted, newer workspace files kept, row counts identical, integrity ok, OpenBot back
online), the socket peer check (host and container callers refused, main pid found), the socket API,
staging up/down (providers off, egress blocked, noVNC answers RFB), the deploy `--staging-first`
pass and refusal, SigV4 against AWS's published test vector, and the gpg off-site archive round
trip.
