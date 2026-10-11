---
name: openbot-host-apps
description: Deploy, monitor, redeploy, fix, and delete apps and databases that run on the OpenBot host server with the appctl command. Use when the user asks to host, deploy, run, update, debug, or look at an app, API, backend, bot, or database on this server.
---

# Apps and databases on the OpenBot host

The host server can run your apps and databases as their own containers. You operate them with `appctl`, a command that talks to a broker on the host. You never touch Docker, and you cannot reach the host. Run `python3 /opt/appctl/appctl help` for the command list. In the examples below `appctl` means that command.

If `appctl` says it cannot reach the broker, the feature is not installed on this server. Tell the user in one sentence and stop.

## When to act

Deploying, replacing, stopping, and deleting are changes on the user's server. Do them only when the user asked for that. A request to build, plan, or review an app is not permission to deploy it. Deleting an app or a database always needs the user's explicit instruction.

## Build and deploy

1. Put the app in `/data/OpenBot/Shared/apps/<name>/` (or work in your own workspace and pass `--src <folder under /data/OpenBot>`). The folder needs a `Dockerfile` at its top level.
2. `appctl deploy <name> [--port N] [--health /path] [--memory MB] [--cpus N]`. It builds, starts, and waits for the app to answer HTTP. A failed new version is rolled back to the previous one automatically.
3. Check the result: `appctl status <name>`, then `appctl logs <name>`. Keep going until the app answers and its logs are quiet.
4. Tell the user the URL that `appctl status` prints.

The same command redeploys: edit the folder, run `appctl deploy <name>` again. The URL, data, environment, and attached databases stay.

An optional `app.json` next to the Dockerfile holds the defaults: `{"port": 8080, "health": "/healthz", "memory_mb": 512, "cpus": 0.5}`. Flags override it.

## What the Dockerfile must satisfy

- The app listens on `0.0.0.0` and on the port you pass (default 3000). The environment variable `PORT` holds it.
- It runs as user id `10001`, never root, with no extra privileges. Make the folders it writes to owned by `10001`, or write only to `/data`.
- `/data` inside the container is the app's own persistent folder. Everything else is rebuilt on each deploy and lost.
- Keep the image small and build reproducibly: pin base image versions, install dependencies in the Dockerfile, add a `.dockerignore` for `node_modules` and `.git`.
- Never put secrets in the image or the source folder.

## Limits

Defaults are 1 GB of memory and 1 CPU per app, at most 4 GB and 4 CPUs, 20 apps, and a shared memory budget for apps and databases together (`appctl overview` shows it). An app that goes over its memory limit is killed and restarted. Ask for more only when the logs show it.

## Environment and secrets

- `appctl env set <name> LOG_LEVEL=debug` sets plain settings. `appctl env list <name>` shows names only; values are never shown.
- A name that contains KEY, TOKEN, SECRET, PASSWORD, AUTH, COOKIE, or SESSION is a secret. Only the user sets those, on the host. Ask the user to add it and say the exact variable name your app reads. Never ask the user to paste a secret into the chat.
- A change to the environment takes effect after `appctl restart <name> --recreate`.

## Databases

- `appctl db create <db> --engine postgres` (also `mariadb` and `redis`) starts a private database with generated credentials. `appctl db attach <db> <app>` connects it to an app and restarts the app with `DATABASE_URL` (or `REDIS_URL`). Your code reads the URL from the environment. You never see the password.
- `appctl db query <db> "<sql>"` runs one statement for inspection, migrations, and fixes. For redis the argument is the command.
- Run migrations when the app starts, or with `db query`. Make them safe to run twice.
- `appctl db backup <db>` before any destructive change, and `appctl db restore <db> <file> --yes` to go back. Backups are also made daily, and the last 7 are kept.
- Never drop, truncate, or restore a database unless the user asked for that. `appctl db delete <db> --confirm <db>` keeps a final backup for 30 days.
- A database is reachable only by the apps attached to it.

## Watching an app

- `appctl list` shows every app with its state and whether it answers.
- `appctl status <name>` shows state, restarts, memory, whether the last health check passed, and recent events (crashes, out-of-memory kills, rollbacks).
- `appctl logs <name> --tail 200 --since 10m`, and `--build` for the last build output.
- A restart count that keeps growing means a crash loop: read the logs, fix the cause, redeploy. Do not just restart it again.
- `appctl rollback <name>` goes back to the previous version. `appctl stop <name>` stops without deleting.

## Access

Every app is served at `https://<name>.<apps domain>`, only through the user's Cloudflare setup. Whether an app is private or public is the user's setting on Cloudflare, not yours: do not promise that a URL is public, and do not tell people to share it. If the user wants an app public, say it is a change they make in Cloudflare.

## Troubleshooting

- Build failed: `appctl logs <name> --build`.
- Starts, then exits: `appctl logs <name>`. Usually a wrong port, a missing environment variable, or a write to a folder owned by root.
- "failed its health check": the app did not answer HTTP on the port in time. Check the port and the `--health` path, which must answer 200 to 399.
- Out of memory: raise `--memory` once, and look for a leak before raising it again.
- "busy with another operation": a deploy is still running. Wait with `appctl job <id> --wait 120`.

## Talking to the user

Report the outcome in plain words: what is running, its URL, what you changed, and anything the user must do (a secret to add, a Cloudflare setting). Do not paste build logs, container names, or command output unless the user asks. When something fails, give the cause in one or two sentences and what you did about it.
