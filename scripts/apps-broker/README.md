# OpenBot apps broker

A root-owned host service that lets OpenBot agents deploy, watch, redeploy, fix, and delete apps
and databases on this server. Agents run `appctl` inside the `openbot` container; it talks to the
broker over a unix socket. Agents never get the Docker socket.

Files: `appsd.py` (broker and admin commands), `appctl` (client, copied next to the socket),
`test_appsd.py` (offline tests: `python3 scripts/apps-broker/test_appsd.py`).

## Install (needs root; not done yet on this host)

```bash
sudo python3 scripts/apps-broker/appsd.py install
```

This creates `/opt/openbot/apps/{client,state,data,build,logs}`, copies the broker and `appctl`,
writes `config.json`, creates `/opt/openbot/data/OpenBot/Shared/apps`, and enables the
`openbot-apps.service` unit. The broker writes `/etc/nginx/conf.d/openbot-apps.conf` and reloads
nginx after every change (it runs `nginx -t` first and restores the old file on failure).

Then add one mount to `/opt/openbot/compose.yaml` (`openbot` service, `volumes`) and run the normal
deploy, which recreates the container:

```yaml
      - ./apps/client:/opt/appctl:ro
```

Inside the container the agents use `python3 /opt/appctl/appctl help`.

## Configuration (`/opt/openbot/apps/config.json`)

`domain` (default `apps.delynith.com`), `max_apps`, `max_total_memory_mb`, `default_memory_mb`,
`default_cpus`, `max_memory_mb`, `max_cpus`, `tls_cert`, `tls_key`. Restart the service after a change.

## What the user must do

- DNS: a wildcard record for `*.<domain>` pointing to this host (proxied through Cloudflare).
- Cloudflare Access: a wildcard policy for `*.<domain>` keeps every app private. A public app needs
  a bypass rule for its hostname. The broker accepts connections only from Cloudflare ranges.
- TLS at the origin: set `tls_cert` and `tls_key`, or use Cloudflare "Flexible" for the apps domain.
- Secret environment values (names with KEY, TOKEN, SECRET, PASSWORD, AUTH, COOKIE, SESSION) are
  user-only: `printf %s "$VALUE" | sudo python3 /opt/openbot/apps/appsd.py env-set <app> <NAME>`.

## Safety properties

- Source folders must resolve inside `/opt/openbot/data/OpenBot`. The build runs on a copy.
- App containers: non-root uid 10001, all capabilities dropped, `no-new-privileges`, memory/CPU/pids
  limits, own bridge network, only `127.0.0.1:<port>` published, own `/data` volume.
- Databases: private `--internal` network shared only with attached apps, generated passwords,
  daily dumps (7 kept), a final dump before deletion, 30 days in `/opt/openbot/backups/apps/_deleted`.
- Deleting an app or database needs its exact name; data is archived, not removed.

## Not verified

The offline tests cover validation, path containment, secret rules and nginx rendering. The Docker,
nginx, systemd and network-isolation behavior has not been exercised on this host yet.
