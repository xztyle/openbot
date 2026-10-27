# OpenBot bench broker

Lets OpenBot agents run heavy jobs (compilations, GPU-rendered tests, screenshots) on a **bench**: a
user's PC running the [bench runner](../bench-runner/README.md). Several benches can be enrolled in a
priority list. If none is available, the job runs on this server in Docker with the same image and
limits, without a GPU. Agents see no difference except the `[bench]` lines in the log.

Files: `benchd.py` (broker, admin commands, install), `benchctl` (agent client, copied next to the
socket), `test_benchd.py` (offline tests, including an end-to-end protocol test:
`python3 scripts/bench-broker/test_benchd.py`). The runner, its installer and the job images are in
`scripts/bench-runner/`; the broker publishes them to runners at `https://<bench host>/v1/dist/`.

```
agent (openbot container, uid 1000)
  benchctl run ... ──unix socket──> benchd.py (root, openbot-bench.service)
                                     ├─ server fallback: docker run (same hardening, no GPU)
                                     └─ 127.0.0.1:8461 <── nginx bench.delynith.com:443 <── Cloudflare
                                                                         ^ outbound HTTPS long-poll
                                                              runner.py on the bench PC (WSL2 + Docker)
```

## Install and update (root)

```bash
sudo python3 scripts/bench-broker/benchd.py install     # files, unit, nginx vhost (nginx -t, reload)
sudo python3 /opt/openbot/bench/benchd.py build-images  # the allowlisted images on this server
```

`install` copies the broker to `/opt/openbot/bench/`, `benchctl` to `/opt/openbot/bench/client/`, the
runner bundle to `/opt/openbot/bench/runner-dist/`, writes `config.json` if missing, enables and restarts
`openbot-bench.service`, and writes `/etc/nginx/conf.d/openbot-bench.conf` (443 only, the Cloudflare
Origin CA certificate from `/opt/openbot/apps/tls/`, only Cloudflare ranges and loopback, 444 otherwise).

The agents' mount, in `/opt/openbot/compose.yaml` (`openbot` service, `volumes`; it takes effect at the
next OpenBot deploy):

```yaml
      - ./bench/client:/opt/benchctl:ro
```

DNS: a proxied A record `bench.delynith.com` -> `158.69.224.199` (SSL mode Full (strict) works with the
origin certificate). Logs: `journalctl -u openbot-bench`. Audit log: `/opt/openbot/bench/audit.jsonl`
(every job: command, image, flags, where it ran, attempts, exit code, sizes; enrollments, revocations,
priority and pause changes).

## Agents

```
benchctl run [--gpu] [--display] [--image NAME] [--timeout S] [--out PATH]... [--cwd DIR]
             [--exclude PATTERN]... [--no-default-excludes] [--detach] -- <command...>
benchctl status | wait <job> | logs <job> | cancel <job>
```

`run` packs the folder (default excludes `.git node_modules __pycache__ .venv venv .cache target
.gradle ...`, plus `.benchignore` and `--exclude`), uploads it (cap `max_upload_mb`), streams the log
live, copies the declared outputs (paths or globs relative to the folder) back into it and exits with
the command's exit code (124 timeout, 125 bench/infrastructure error, 130 cancelled; Ctrl-C cancels).
Inside the job: `/work` is the folder (the only writable path besides a `/tmp` tmpfs), `HOME=/tmp`,
`BENCH_HOST` (bench name or `server`), `BENCH_GPU`, `BENCH_DISPLAY`; `--display` starts Xvfb as `:99`.

## Admin

```bash
sudo python3 /opt/openbot/bench/benchd.py enroll <name> --priority N   # one-time code, 30 minutes
sudo python3 /opt/openbot/bench/benchd.py list
sudo python3 /opt/openbot/bench/benchd.py priority <name> N
sudo python3 /opt/openbot/bench/benchd.py pause <name>    # no new jobs; running ones finish
sudo python3 /opt/openbot/bench/benchd.py resume <name>
sudo python3 /opt/openbot/bench/benchd.py revoke <name>   # immediate
```

## Scheduling

A job goes to the highest-priority bench that is online (a poll within 30 s), not paused (by the admin
or by the user on the PC), not user-busy, has the image (and a GPU for `--gpu`) and a free slot (1 job
by default). Otherwise it runs on the server (`server_slots`, default 2; it waits for a slot). If a bench
goes offline, does not pick a job up, or reports it cannot run it, the job runs once more on the next
option. A bench that pauses a job for 10 minutes hands it back, and it runs on the next option.

## Configuration (`/opt/openbot/bench/config.json`, restart the service after a change)

`images` (name -> image reference; the allowlist), `default_image`, `default_timeout_s` (1800),
`max_timeout_s` (7200), `max_upload_mb` (1024), `max_output_mb` (2048), `max_log_mb` (20),
`heartbeat_s` (30), `enroll_ttl_s` (1800), `max_queued_jobs` (16), `min_free_disk_mb`,
`job_keep_hours` (24), `server_fallback`, `server_slots`, `server_limits` (`memory_mb` 8192, `cpus` 4,
`pids` 4096, `tmp_mb` 4096), `public_url`, `server_name`, `listen_port` (8461), `tls_cert`, `tls_key`.

### Adding an image (for example Godot)

1. Add `scripts/bench-runner/images/godot/Dockerfile` that starts `FROM openbot-bench/base:1` (it keeps
   the entrypoint: Xvfb, low priority, uid 10010) and installs Godot (pin the version, verify the
   checksum).
2. Add `"godot": "openbot-bench/godot:4.4"` to `images` in `config.json`.
3. `sudo python3 scripts/bench-broker/benchd.py install` and
   `sudo python3 /opt/openbot/bench/benchd.py build-images`.
4. Benches build missing images by themselves within 6 hours or at their next start (or right away with
   `openbot-bench sync-images` on the PC). A bench gets jobs for an image only once it has built it.

Agents then use `benchctl run --image godot --display -- godot --headless ...`.

## Threat model

- **Agents** (uid 1000 in the `openbot` container) can only submit fixed job specs: an allowlisted
  image, a command, the gpu/display flags, a bounded timeout and relative output paths. No Docker flags,
  mounts, environment or network options. All agents share one socket, so any agent can see and cancel
  any job (as with `appctl`).
- **Job containers** (server and bench): read-only root, `/tmp` tmpfs, only the job folder writable and
  mounted, `--cap-drop ALL`, `no-new-privileges`, uid 10010, memory/CPU/pids limits, no Docker socket.
  Network: the `openbot-bench` bridge (`obbench0`, 10.213.0.0/24, no inter-container traffic); iptables
  drops everything from it to the host itself (`INPUT`) and to 10/8, 172.16/12, 192.168/16, 169.254/16,
  100.64/10 (`DOCKER-USER`), so a job reaches the internet but not OpenBot, other apps, the host's
  services or a LAN. The broker re-applies these rules at start and before every server job.
- **Archives**: inputs and outputs are extracted with Python's `data` filter (no absolute paths, no
  `..`, no links out, no devices); outputs skip links that leave the job folder; caps on upload, output
  and log size.
- **Runners** authenticate every request with HMAC-SHA256 over method, path, timestamp, nonce and body
  hash with a per-bench 256-bit secret (root-only in `/opt/openbot/bench/keys/`). Requests more than
  5 minutes off, from before the broker started, or with a reused nonce are refused. Poll replies (the
  job specs) are signed back, and the input carries a SHA-256 in the signed spec, so even Cloudflare
  (which terminates TLS) cannot inject or alter jobs undetected. A bench can only touch jobs assigned to
  it.
- **Enrollment codes** are 100-bit, single use (deleted at the first attempt, even an expired one), valid 30 minutes,
  stored hashed, rate-limited (30 attempts per 10 minutes).
- **Revocation**: `benchd.py revoke <name>` deletes the secret; the very next request of that bench is
  refused and its jobs run elsewhere. To re-add the PC, enroll it again and run the installer with
  `-Code`.
- **Trust in the other direction**: a bench trusts the broker. A compromised server could send any job
  (still sandboxed as above) and make benches build images from Dockerfiles it publishes (builds run on
  the distro's default bridge, which the runner firewall also cuts off from the LAN and the PC).
- The broker is reachable only through Cloudflare (direct connections get 444). `/v1/dist/` (the runner
  code, no secrets) and `/v1/runner/enroll` are the only unauthenticated runner endpoints.

## Not covered

- Jobs do not survive a broker restart (clients get an error; benches drop them).
- No build cache between runs: each job starts from a fresh container and the uploaded folder.
- Agents are not isolated from each other on this socket.
