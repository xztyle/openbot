# Docker

The OpenBot image is the Linux release, run as a [self-hosted server](self-hosted-server.md) in a
container. It is a normal Remote host of your account. You use it from the desktop app, the iPhone
app or `openbot.run/app`. The image is `ghcr.io/nightly-labs/openbot`, for `linux/amd64` and
`linux/arm64`.

## Run

With Docker Compose:

```sh
curl -fsSLO https://raw.githubusercontent.com/nightly-labs/openbot/main/docker/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/nightly-labs/openbot/main/docker/seccomp.json
docker compose up -d
docker compose exec openbot openbot login
```

With `docker run`:

```sh
curl -fsSLO https://raw.githubusercontent.com/nightly-labs/openbot/main/docker/seccomp.json
docker run -d --name openbot --restart unless-stopped \
  --security-opt seccomp=seccomp.json --security-opt no-new-privileges:true \
  --shm-size 1g --stop-timeout 60 \
  -v openbot-data:/data \
  ghcr.io/nightly-labs/openbot:latest
docker exec -it openbot openbot login
```

`openbot login` asks for your email and the code that OpenBot sends to it. After the sign-in, the
server shows in the server list of that account. Then connect a provider from the app, as on a
[hosted server](hosted-servers.md#providers).

The options in both examples are necessary:

| Option | Why |
| --- | --- |
| `seccomp=seccomp.json` | The Electron sandbox makes user namespaces. The default seccomp profile of Docker refuses them, and the container stops with a message. See [Security](#security). |
| `--shm-size 1g` | Chromium uses shared memory. The Docker default of 64 MB is too small. |
| `--stop-timeout 60` | OpenBot stops its agents and closes its database before it exits. |
| `-v openbot-data:/data` | All data is in `/data`. Without a volume, it goes away with the container. |

The container publishes no port. OpenBot only connects out: to the account server, to the providers,
and to Signal and TURN for remote use. The Team API listens on `127.0.0.1` in the container.

## Tags

| Tag | Image |
| --- | --- |
| `latest` | The newest release. |
| `<version>`, for example `0.30.0` | One release. Use it to choose when to upgrade. |
| `v<version>` | Alias for `<version>` in releases published after 0.31.0. Earlier releases use the tag without `v`. |
| `sha-<commit>` | The release of that commit. |
| `<version>-amd64`, `<version>-arm64` | One release for one architecture. |

Public images need no GHCR sign-in. If `latest` or a version without `v` returns `denied`,
`unauthorized` or `not found`, a maintainer must check the package visibility. See
[Docker package access](RELEASING.md#docker-package-access).

## Data

`/data` is the home folder of the user `openbot` (UID 1000, GID 1000). OpenBot and its agents run as
that user and keep everything there:

| Path | Contents |
| --- | --- |
| `/data/.config/OpenBot` | The database `openbot.db`, logs, the downloaded provider runtimes and the browser data. |
| `/data/OpenBot` | The agent workspaces (`Agents`), `Shared` and `Downloads`. |
| `/data/.local/share/keyrings`, `/data/.config/openbot-container` | The keyring and its password. The keyring has the key of the encrypted data in `/data`. |
| Other files in `/data` | Provider sign-ins and the files of agent tools, for example `~/.codex` and `~/.claude`. |

Keep `/data` as one unit. The encrypted data cannot open without the keyring, and the keyring cannot
open without its password file. Use one volume for one container at a time.

For a bind mount, give the folder to the user of the image first:

```sh
mkdir openbot-data && sudo chown 1000:1000 openbot-data
```

The data has your account session, your provider sign-ins and your conversations. Protect it as you
protect a home folder. To back up the database while OpenBot runs, see [Backup](#backup-and-upgrade-rehearsal).
To back up everything, stop the container and copy the volume.

## Commands

In the container, `openbot status`, `health`, `backup`, `diagnostics`, `analytics`, `login`,
`logout`, `name` and `version` work as on a [self-hosted server](self-hosted-server.md#commands). Do
the other tasks with Docker on the host:

| Task | Command |
| --- | --- |
| Read the log | `docker logs openbot` |
| Stop, start, restart | `docker stop openbot`, `docker start openbot`, `docker restart openbot` |
| Upgrade | `docker compose pull && docker compose up -d`, or pull the image and make the container again with the same volume |
| Remove | `docker exec openbot openbot logout`, then `docker stop openbot && docker rm openbot`. The data stays in the volume. `docker volume rm openbot-data` deletes it. |

## Upgrades

OpenBot does not update itself in a container. A new image replaces it. Do not go back to an older
tag: an older OpenBot cannot open a database that a newer one migrated, so it does not start.

A database migration cannot be undone, and OpenBot does not copy the database before it migrates.
Before each upgrade:

1. Wait until the server is idle. `docker exec openbot openbot status` shows `Restart: safe now`.
2. Make a [backup](#backup-and-upgrade-rehearsal).
3. Run the new image on a copy of your data, with no network (the rehearsal).
4. Upgrade.

## Backup and upgrade rehearsal

`openbot backup <file>` writes a copy of the database `openbot.db` while OpenBot runs. It uses the
SQLite online backup, so the copy is consistent, also when the write-ahead log has recent changes. It
never runs by itself: you start it. It also:

- refuses to replace a file, and refuses a path that is not absolute or a folder that does not exist;
- makes the file private (mode 0600) and writes one single file, with no `-wal` or `-shm` file;
- checks the copy with `PRAGMA integrity_check`, and shows the size and the schema version. If the
  check fails, it leaves no file;
- needs free disk space of about the size of the database, and refuses if there is less;
- runs one at a time. A large database makes the command slow, and OpenBot stays usable.

### Make the backup

```sh
docker exec openbot mkdir -p /data/backups
docker exec openbot openbot backup /data/backups/pre-upgrade.db
docker cp openbot:/data/backups/pre-upgrade.db ./pre-upgrade.db
```

Keep a copy outside the volume. A backup in the volume does not help when the volume is lost.

The database is not enough alone. These parts of `/data` must go with it, and are not in the copy:

| Part | Why |
| --- | --- |
| `/data/.local/share/keyrings` and `/data/.config/openbot-container` | The keyring and its password file. The database holds data that only this keyring can open. A restore without them cannot read it. |
| The files in `/data/.config/OpenBot` (not the folders) | Account session, provider keys and settings. They are encrypted with the same keyring. |
| `/data/OpenBot` | The workspaces of the agents. The database does not hold them. |
| `/data/.codex`, `/data/.claude` and the other provider folders | The provider sign-ins. |

To keep all of it, stop the container and copy the whole volume.

### Rehearse the upgrade

The rehearsal starts the new image on a copy of your data and checks that it can migrate the
database. Use `--network none`. The copy holds your account session and the identity of your server.
With a network, the copy would connect as a second instance of your server.

```sh
NEW=ghcr.io/nightly-labs/openbot:<new version>
docker pull "$NEW"
docker volume create openbot-rehearsal
docker run --rm --user 0 --network none --entrypoint /bin/sh \
  -v openbot-data:/from:ro -v openbot-rehearsal:/to "$NEW" -c '
    set -e
    mkdir -p /to/.config/OpenBot /to/.local/share
    cp -a /from/.local/share/keyrings /to/.local/share/
    cp -a /from/.config/openbot-container /to/.config/
    find /from/.config/OpenBot -maxdepth 1 -type f ! -name "openbot.db*" -exec cp -a {} /to/.config/OpenBot/ \;
    cp /from/backups/pre-upgrade.db /to/.config/OpenBot/openbot.db
    chown -R 1000:1000 /to'
docker run -d --name openbot-rehearsal --network none \
  --security-opt seccomp=seccomp.json --security-opt no-new-privileges:true \
  --shm-size 1g --stop-timeout 60 -v openbot-rehearsal:/data "$NEW"
docker exec openbot-rehearsal openbot status
docker exec openbot-rehearsal openbot health
```

The rehearsal passes when `openbot health` prints `healthy`, `status` shows `Agents: ready`, and the
schema version is the one that the new release expects. With no network, `status` shows an account
error and the server is not online. This is expected. If the migration fails, the container stops, or
`docker logs openbot-rehearsal` shows the reason. Your real data is not changed. Clean up:

```sh
docker rm -f openbot-rehearsal
docker volume rm openbot-rehearsal
```

### Restore

Use the restore only when an upgrade failed, or the database is damaged. An older OpenBot cannot
open a database that a newer one migrated. So restore the backup, and start the old image again.

```sh
docker stop openbot
OLD=ghcr.io/nightly-labs/openbot:<old version>
docker run --rm --user 0 --entrypoint /bin/sh -v openbot-data:/data "$OLD" -c '
  set -e
  cd /data/.config/OpenBot
  mv openbot.db openbot.db.replaced
  rm -f openbot.db-wal openbot.db-shm
  cp /data/backups/pre-upgrade.db openbot.db
  chown 1000:1000 openbot.db
  chmod 600 openbot.db'
```

Remove `openbot.db-wal` and `openbot.db-shm`. A leftover log file from the newer run would be applied to
the restored database and damage it. Then start the container with the old image. If the backup is
outside the volume, copy it in first with `docker cp`.

## Health, logs and diagnostics

The image has a Docker health check: it runs `openbot health` every 30 seconds. The container is
`healthy` when the control socket answers, the agents started and the database is readable. The
first 5 minutes after the start do not count, so a long migration can finish. Docker only marks the
container. It does not restart a container because it is unhealthy. A tool such as `autoheal`, or
your deploy script, has to act on `docker inspect --format '{{.State.Health.Status}}' openbot`.

`openbot status` shows these lines in addition to the account and the server. `openbot status --raw`
prints the `key=value` lines for scripts. The keys `account`, `server`, `email`, `version` and the
other earlier keys do not change.

| Key | Meaning |
| --- | --- |
| `health`, `health_problems` | `ok` or `unhealthy`, and the reason codes (`agent_init_failed`, `agent_init_not_ready`, `database_unreadable`). |
| `agent_init`, `agent_init_message` | `ok`, `pending` or `failed`. A failure shows a short, redacted reason. A failed start is not retried by itself: restart the container. |
| `schema_version` | The newest applied database migration. |
| `safe_to_restart`, `busy` | `yes`, or `no` with the reasons: `agent-turn`, `queued-delivery`, `drain-task`, `routine-run`, `channel-work`, `provider-process`, and others. A delivery that is `starting` counts as busy. |
| `providers`, `provider_retry` | The state of each provider. A provider that stopped is started again in the background: 3 quick tries, then every 30 seconds up to every 10 minutes. `provider_retry` shows the attempts and the time to the next one. |
| `memory` | `ok`, `low` or `critical`. See [Memory](#memory). |
| `uptime_s`, `last_shutdown`, `starts_24h` | `last_shutdown` is `clean`, `unclean` (the last run was killed or crashed) or `unknown`. `starts_24h` counts the starts in the last day, so a restart loop shows. |
| `running_turns`, `longest_turn_s`, `longest_turn_idle_s`, `silent_turns` | The running turns, the age of the oldest, and the longest time that a turn got nothing from its provider. OpenBot writes one warning to the log for each turn that is silent for 30 minutes. It never stops a turn. Set `OPENBOT_SILENT_TURN_MINUTES` (1 to 1440) to change the time. |
| `analytics` | `on` or `off`. See [Product analytics](#product-analytics). |

**Logs.** OpenBot writes its log to the output of the container: `docker logs openbot`. Docker keeps
it without a limit by default. Limit it in the Compose file (`docker/compose.yaml` does this):

```yaml
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
```

With `docker run`, use `--log-opt max-size=10m --log-opt max-file=3`. The setting applies when the
container is made, so make the container again after you change it. `OPENBOT_LOG_LEVEL` sets the
level of the log: `trace`, `debug`, `info` (default), `warn`, `error` or `silent`. Secrets are
redacted in the log at every level.

**Diagnostics.** `docker exec openbot openbot diagnostics` prints the diagnostics report as JSON. It
is the same report as **Export diagnostics** in the app, and has no conversations, URLs, email
addresses, tokens, file contents or file paths. Add a file name to save it in the container
(`openbot diagnostics /data/backups/diagnostics.json`). It never replaces a file.

### Memory

OpenBot reads the memory of the container (cgroup v2 `memory.max` and `memory.current`) and of the
machine (`/proc/meminfo`), whichever is smaller. When memory is low, new turns wait in the queue and
start when memory is free. No message is lost. At a critical level, OpenBot also closes idle provider
processes. The number of turns that run at the same time depends on the memory: 4 up to 5 GiB,
8 up to 10 GiB, and 16 above. Processes that agents start get a higher OOM score, so the kernel stops
an agent tool before it stops OpenBot. Set `mem_limit` in the Compose file to make the limit
explicit.

### Product analytics

Analytics are on by default in a release build. To turn them off for a server with no window, set
`OPENBOT_ANALYTICS=off` (or `DO_NOT_TRACK=1`) in the environment. This holds for the whole run and
cannot be turned on again while it is set. Or run `docker exec openbot openbot analytics off`, which
saves the choice as the **Share product analytics** setting does. `openbot analytics` shows the state.

## Environment

Pass these with `-e` or the `environment` of the Compose file, never in an image. Agents inherit the
environment of OpenBot, so they can read these values.

| Variable | Use |
| --- | --- |
| `XAI_API_KEY`, `CURSOR_API_KEY`, `CLINE_API_KEY` | A provider API key. |
| `OPENBOT_CODEX_PATH`, `OPENBOT_CLAUDE_PATH`, `OPENBOT_GROK_PATH`, `OPENBOT_OPENCODE_PATH`, `OPENBOT_CURSOR_PATH`, `OPENBOT_CLINE_PATH`, `OPENBOT_ANTIGRAVITY_PATH` | Another provider executable. Mount it read-only in the container. |
| `OPENBOT_AUTH_API_URL` | Another account server, for example a [self-hosted account service](self-hosting.md). |
| `OPENBOT_ANALYTICS` | `off` turns product analytics off for the run. `DO_NOT_TRACK=1` does the same. |
| `OPENBOT_LOG_LEVEL` | The log level: `trace`, `debug`, `info` (default), `warn`, `error` or `silent`. |
| `OPENBOT_SILENT_TURN_MINUTES` | Minutes without provider output before OpenBot logs a warning for a turn (default 30). |

## Security

- **The Electron sandbox stays on.** `seccomp.json` is the default profile of Docker
  ([moby/profiles](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json))
  with one more rule: `clone` and `unshare` without limits on their flags. This lets the container
  make user namespaces, which gives processes in the container more of the kernel to call. The kernel
  still refuses other namespaces to a process that is not in its own user namespace. Do not use
  `seccomp=unconfined`, `--privileged` or `--no-sandbox` instead.
- **Not root.** The image runs as UID 1000. Root owns the release, so agents cannot change it. The
  release has no SUID file. `no-new-privileges` keeps it that way.
- **Agents have full access in the container.** They run commands, change all of `/data` and use the
  network. The container is the boundary. Do not mount the Docker socket, your home folder or another
  host folder that agents must not change.
- **Check the image.** Each release image has a build provenance attestation:

  ```sh
  gh attestation verify oci://ghcr.io/nightly-labs/openbot:<version> --repo nightly-labs/openbot
  ```

## How it works

The release workflow (`.github/workflows/release.yml`) builds the image on a runner of each
architecture from the AppImage of that release, after it checks the AppImage against the release
checksums. `docker/Dockerfile` unpacks the AppImage to `/opt/OpenBot/app` and installs the packages
of a self-hosted server from that release. The workflow starts and stops each image once, and pushes
the images to GHCR only after the GitHub Release is published.

`tini` is process 1. It starts `resources/hosting/openbot-container` from the release, which checks
that it can make a user namespace, starts D-Bus, a virtual display and the keyring, and then becomes
OpenBot with `OPENBOT_SERVER=1`. On a stop, tini gives the signal to OpenBot and waits for it.
`/opt/OpenBot/hosted/mode` is `container`, so the `openbot` command talks to the control socket and
does not use systemd.

## Limits

- Remote desktop and Computer Use need a display. The container has a virtual display, but remote
  desktop and Computer Use were not tested in it. The arm64 release has no remote desktop runtime.
- Voice prompts are not available on Linux.

## Not confirmed

- Tested on Docker Desktop 4.45 (Docker Engine 28.3, `linux/arm64`) with the 0.29.0 AppImage and the
  scripts of this image: the start with the sandbox on, `openbot status`, a restart, a new container
  on the same volume after a kill, a stop that exits with 0, and the messages for a missing seccomp
  profile and for a volume that the user cannot write. The release workflow also starts each image.
- Not tested: the rehearsal with `--network none` and the restore recipe in a real container, the
  health check in Docker, and the memory guard on cgroup v1 hosts. The code paths have unit tests only.
- Not tested: a sign-in with `openbot login` in a container, remote use of a container from the app,
  Podman, Kubernetes, rootless Docker, and hosts that restrict user namespaces with AppArmor, such as
  Ubuntu 23.10 or newer. On such a host, the container can need an AppArmor profile that permits
  `userns`.
