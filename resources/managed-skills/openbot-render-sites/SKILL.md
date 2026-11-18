---
name: openbot-render-sites
description: Publish static landing pages on Render.com with the render-sites helper - push a landing's files to the user's GitHub landings repository, create the Render static site, deploy new versions, add the user's own domain with Cloudflare DNS, check deploy status and logs, and suspend or delete a site when the user asks. Use when the user asks to publish, deploy or update a landing page or static site, or to put one on their own domain.
---

# Render landing pages

You publish static landing pages with `render-sites.mjs`, a helper that ships with OpenBot. It keeps each
landing's files in a GitHub repository, builds the site on Render.com (Render API `v1`), and points the user's
domain at it with Cloudflare DNS. It prints JSON.

## The helper

On the OpenBot server the helper is `/opt/OpenBot/app/resources/managed-skills/openbot-render-sites/render-sites.mjs`.
Start each command with these lines. The loop also finds the helper in the desktop app. The three `<path>` values
are the paths of the shared keys `RENDER_API_KEY`, `CLOUDFLARE_API_TOKEN` and `GITHUB_TOKEN` from
`openbot.list_api_keys` (or of the keys that hold these values under other names):

```bash
for R in /opt/OpenBot/app/resources /Applications/OpenBot.app/Contents/Resources /opt/OpenBot/resources; do
  R="$R/managed-skills/openbot-render-sites/render-sites.mjs"; [ -f "$R" ] && break; done
[ -f "$R" ] || R=$(find / -maxdepth 8 -path '*/managed-skills/openbot-render-sites/render-sites.mjs' 2>/dev/null | head -n 1)
export RENDER_API_KEY_FILE='<path>' CLOUDFLARE_API_TOKEN_FILE='<path>' GITHUB_TOKEN_FILE='<path>'
export RENDER_SITES_ACTOR='<your name>'
node "$R" help
```

In the examples below `render-sites` means `node "$R"`. The helper reads the keys from the files and never prints
them. Do not print, copy or pass them in any other way. A command needs only the keys of the services it uses:
reading sites needs only Render; `create` and `deploy --dir` also need GitHub; `domain` also needs Cloudflare.

The settings and the audit log are in `render-sites/` in the shared directory of your space (on the server
`/data/OpenBot/Spaces/<space>/Shared/render-sites/`). `render-sites config show` shows the folder. Every agent of
your space uses the same files; another space has its own.

Exit codes: 0 done, 1 error (JSON on standard error, with the service's message and a `hint`), 2 wrong command,
3 refused (needs `--approved`), 4 rate limited for longer than `--max-wait` seconds (default 120), 5 still running
after `--timeout` (run `wait` or `domain verify` again later).

## One-time setup

Do these steps with the user once. The user does the steps in Render, GitHub and Cloudflare; you do the OpenBot
steps. Never ask for a key in chat. If the user pastes one in chat, do not repeat it, and ask again with
`openbot.request_api_key`. Only the server owner or an admin can answer the form, and not in a Slack, Discord or
Telegram chat.

1. **Render API key.** In the Render dashboard, open **Account Settings → API Keys** and choose **Create API Key**.
   A key can use every workspace of the user. Save it: `openbot.request_api_key` with `name: "RENDER_API_KEY"` and
   `shared: true`.
2. **GitHub repository and token.** The default is one private repository `landings`, with one folder per landing
   (`sites/<name>/`). The user creates it on github.com (**New repository**, name `landings`, private; it may be
   empty), under their account or their organization. Then **Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token**:
   - Resource owner: the account or organization of the repository.
   - Repository access: **Only select repositories** → `landings`.
   - Permissions → Repository: **Contents: Read and write** (Metadata: Read is added by GitHub).
   - Expiration: as long as the user accepts. Save it as `GITHUB_TOKEN`, `shared: true`.

   If the user wants one repository per landing (`config set repoMode repo-per-site`), the token needs
   **All repositories** and also **Administration: Read and write**, so the helper can create the repositories.
3. **Render can read the repository.** On github.com open **Settings → Applications → Installed GitHub Apps**
   (for an organization: the organization's **Settings → GitHub Apps**), choose **Configure** next to **Render**,
   and under **Repository access** add `landings` (or **All repositories** for one repository per landing). If
   Render is not in the list, the user connects GitHub in the Render dashboard first (**New → Static Site →
   Connect GitHub**). Without this, `create` stops with `repo_not_accessible` and these steps.
4. **Cloudflare token.** In Cloudflare, **My Profile → API Tokens → Create Token → Create Custom Token**:
   - Permissions: **Zone → Zone → Read** and **Zone → DNS → Edit**. Optional: **Zone → Zone Settings → Read**, so the
     helper can check the SSL/TLS mode before it turns the proxy on.
   - Zone Resources: **Include → Specific zone →** each domain the user wants for landings (or **All zones** of the
     account).
   - Save it as `CLOUDFLARE_API_TOKEN`, `shared: true`. The token cannot change other settings or other zones.
5. **Check and configure.** `render-sites whoami` checks each key: the Render user and workspaces, the GitHub user,
   and the Cloudflare zones. Then:
   - `render-sites config set ownerId <id>` (the Render workspace; ask the user when there is more than one),
   - `render-sites config set githubOwner <org>` only when the repository belongs to an organization,
   - optional: `landingsRepo`, `sitesFolder` (default `sites`), `branch` (default `main`), `repoMode`
     (`monorepo` or `repo-per-site`), `buildCommand` and `publishPath` (defaults: no build, publish the folder).

## Publish a new landing

1. **Build the folder.** Put the finished site in one folder, with `index.html` at its top and relative links to
   its CSS, images and scripts. Plain HTML needs no build. For a framework (for example Vite), push the source and
   add `--build-command "npm ci && npm run build" --publish-path dist`. `.git` and `node_modules` are not sent.
2. **Check the claims.** If the landing makes claims (results, health, money, prices, guarantees, testimonials) and
   your space has a compliance reviewer, get the reviewer's OK first.
3. **Create.** `render-sites create black-friday --dir ./landing --reason "Black Friday offer"`. The name is lower
   case letters, digits and dashes; it is the Render site name and the folder name. The helper:
   - refuses files that usually hold secrets (`.env`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`) and files that hold a
     value that looks like a key; nothing is sent until you remove them;
   - creates the repository when it does not exist (private), and makes `sites/black-friday/` hold exactly the
     folder's files, in one commit;
   - creates the Render static site from that folder, with auto-deploy on each push that changes the folder;
   - waits for the first deploy (`--timeout` seconds, default 600) and answers the `onrender.com` URL.
   `--dry-run` shows the repository, folder and site settings first. `--no-wait` returns at once; then use
   `render-sites wait black-friday`.
4. **Domain** (when the user wants one): see below.
5. **Report** in one line with the link: "Black Friday landing is live: https://black-friday.onrender.com".

## Update a landing

`render-sites deploy black-friday --dir ./landing --message "New price"` pushes the folder again and waits for the
deploy of that commit. The folder replaces the landing's folder in the repository: a file that is not in your
folder is deleted there. Send the whole site, not only the changed files. Only this landing deploys; the other
landings of the repository do not. With no change in the files, nothing deploys (`--force` deploys again).

- `render-sites deploy <site>` deploys the last commit again (`--clear-cache` for a clean build).
- `render-sites update <site> --build-command "..." --publish-path dist` changes the build; `--env KEY=VALUE`
  (repeat it) and `--unset-env KEY` change build environment variables. These apply from the next deploy.
  A static site's environment variables are visible to anyone who reads the built pages: never put a secret there.
- `--headers @headers.json` (a list of `{"path":"/*","name":"X-Frame-Options","value":"DENY"}`) and
  `--routes @routes.json` (a list of `{"type":"redirect"|"rewrite","source":"/old","destination":"/"}`) replace all
  rules of the site. Read the current ones with `render-sites site <site>` first.

## Add a domain

`render-sites domain add black-friday promo.example.com --reason "Black Friday URL"`:

1. The helper finds the Cloudflare zone that holds the hostname (the longest zone name that ends it). With no zone
   it stops with `zone_not_found` and lists the zones the token can see.
2. If the name already has an A, AAAA or CNAME record that the helper did not make, it stops with `dns_conflict`
   and changes nothing. Ask the user to remove or change that record, or to pick another hostname.
3. It adds the domain on Render. For an apex (`example.com`) Render also adds `www.example.com` (and the reverse),
   and redirects one to the other; the helper makes a record for both.
4. It creates a `CNAME` from the hostname to the site's `onrender.com` host, **DNS only** (not proxied), with the
   record comment `openbot-render:<site id>`. At the apex Cloudflare flattens the CNAME, as Render's guide says.
5. It asks Render to verify, and waits (default 300 seconds). After verification Render issues the TLS
   certificate. Exit code 5 means not verified yet: run `render-sites domain verify <site> <hostname>` later.

Why DNS only: Render must see its own address on the name to verify the domain and issue the certificate
(Render's Cloudflare guide). Proxied is optional after that. To turn on the Cloudflare proxy, run
`render-sites domain proxy <site> <hostname> on` after the certificate works, or add `--proxied` to `domain add`
(the helper turns it on only after verification). The zone's SSL/TLS mode must be **Full** or **Full (strict)**:
with Flexible the page loops, and the helper refuses. The helper never changes the SSL/TLS mode, because it is
a setting of the whole zone; ask the user to change it. Keep DNS only when there is no reason for the proxy.

The helper changes and deletes only records with its marker comment. It never touches other records. Render
plans include a limited number of custom domains; when Render answers 402, tell the user.

- `render-sites domain list <site>`: Render's domains, their verification and the helper's records.
- `render-sites dns <site>`: every record that the helper made for the site.

## Status and logs

- `render-sites sites`, `render-sites site <site>` (URL, repository folder, domains, headers, routes, last deploy).
- `render-sites deploys <site>`, `render-sites deploy-status <site> [<deploy id>]`, `render-sites wait <site>`.
- `render-sites logs <site>`: the build log when Render gives it through the API; otherwise the answer has the
  dashboard link, where the deploy's log is.
- `render-sites audit --tail 20`: the last changes.

Deploy statuses: `created`, `queued`, `build_in_progress`, `update_in_progress` (running); `live` (done);
`build_failed`, `update_failed`, `canceled`, `pre_deploy_failed` (failed: read the log, fix, deploy again);
`deactivated` (a newer deploy replaced it).

## Safety rules

- Delete a site (`delete <site> --approved`), suspend it (`suspend <site> --approved`) or remove a domain
  (`domain remove <site> <hostname> --approved`) only when the user asked for it in this conversation. Confirm
  with `openbot.ask_ui` first. Without `--approved` the helper refuses (exit code 3) and logs the refusal. `delete`
  also removes the helper's DNS records of the site (`--keep-dns` keeps them); the files stay in GitHub.
- Never commit keys, passwords or private customer data into the repository. A landing that needs a key calls a
  server; the page never holds it.
- Landings with claims go through the space's compliance reviewer when there is one.
- Do not edit `audit.jsonl`. Every change, refusal and error is written there with the actor and `--reason`.
- Do not change records in Cloudflare by other means, and do not touch DNS records that the helper did not make.

## Errors

- `repo_not_accessible`: Render cannot read the repository. Give the user the steps in the `hint` (setup step 3)
  once, then run the same command again. The files are already pushed; nothing is lost.
- `zone_not_found`: the domain is not in Cloudflare, or the token has no access to its zone (setup step 4).
- `dns_conflict`: the name has records that the helper did not make. The user decides.
- Render 401, Cloudflare 401 or GitHub 401: the key is wrong or expired; ask for a new one with
  `openbot.request_api_key`. GitHub 403 or 404: the token has no access to the repository (setup step 2).
- Render 409 on `create`: the name is taken in the workspace; use another name or `deploy` to the existing site.
- A failed build: `render-sites logs <site>`; fix the files or the build command and deploy again.
- Rate limits: the helper waits and tries again. Render allows 20 new sites an hour and 10 deploys a minute per
  site. Exit code 4 means wait some minutes. Do not loop.

## Talking to the user

Report one line with the link: "Landing live: https://promo.example.com" or "Deploy failed (build_failed); the log
says the file dist/ is missing. I am fixing it." Say what needs the user's action (for example the one-time GitHub
step). Do not paste raw JSON, keys or repository internals.
