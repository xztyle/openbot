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

`domain` (default `apps.delynith.com`; this host uses `delynith.com`), `max_apps`, `max_total_memory_mb`,
`default_memory_mb`, `default_cpus`, `max_memory_mb`, `max_cpus`, `tls_cert`, `tls_key`, `public_ipv4`
(A record target, default `158.69.224.199`), `cloudflare_zone` / `cloudflare_zone_id` (optional).
Restart the service after a change.

## Public DNS and origin TLS (automatic)

Hosting publishes an app at `https://<app>.<domain>` by default. `appctl deploy --private` (or
`appctl unpublish <app>`) keeps an app internal; `appctl publish <app>` makes it public again. Private
apps get no DNS record and no entry in the apps nginx vhost. Apps from before this flag are public,
except `porttest` and `tts-gateway`.

The broker needs a Cloudflare API token with Zone DNS Edit and Zone SSL and Certificates Edit on the
zone, in a root-only file (agents never see it; it is never logged or given to an app):

```bash
sudo install -d -m 700 /opt/openbot/secrets
sudo install -m 600 /dev/stdin /opt/openbot/secrets/cloudflare-dns.env <<< 'CLOUDFLARE_API_TOKEN=...'
```

The file is read again on each use. Within 5 minutes (or at the next deploy or broker restart) the
broker then:

- creates a proxied A record `<app>.<domain>` -> `public_ipv4` for each public app, with the comment
  `openbot-apps:<app>`. It changes or deletes only records that carry that comment, and reports
  `failed` when another record already uses the name. Deleting or unpublishing an app removes its
  record.
- gets a Cloudflare Origin CA certificate (15 years) for `*.<domain>` and `<domain>`, stores it in
  `/opt/openbot/apps/tls/` (root-only), sets `tls_cert`/`tls_key` and serves the apps vhost on port
  443 too. On failure it logs and stays on port 80 (retry after one hour). With an origin
  certificate the zone can use SSL mode Full (strict) and no per-app SSL rule is needed.

Without the file nothing is sent to Cloudflare and `appctl status` shows `dns: pending (no token)`.
`appctl status` and deploy output show `published`, `pending`, `failed: <reason>` or `private`.

## What the user must do

- The Cloudflare token file above (DNS records and origin TLS follow from it).
- Optional Cloudflare Access policies for apps that need a login. The broker accepts connections only
  from Cloudflare ranges and loopback.
- Secret environment values (names with KEY, TOKEN, SECRET, PASSWORD, AUTH, COOKIE, SESSION) are
  user-only: `printf %s "$VALUE" | sudo python3 /opt/openbot/apps/appsd.py env-set <app> <NAME>`.

## Public TCP ports (host-owned)

An app can be given a public TCP port for something that is not HTTP behind Cloudflare, such as a
TLS websocket for a remote worker. Only the host config does this; agents cannot:

```json
"public_ports": { "tts-gateway": [ { "host_port": 8050, "container_port": 8443 } ] }
```

Put it in `/opt/openbot/apps/config.json` and run `appctl restart <app> --recreate` (or redeploy).
Rules: host port 1024-65535, not 22/53/80/443/3478/5349/8080/8081, not the broker's 20000-20999
range or TURN's 49152-49215, and one app per host port. Docker publishes on every interface and
**bypasses ufw**, so the rule above is the only gate. `appctl status <app>` lists the mapping.

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
