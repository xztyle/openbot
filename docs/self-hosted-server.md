# Self-hosted servers

A self-hosted server is the Linux OpenBot build on your own computer with no screen: a VPS, a home
server or a cloud VM. It is a normal Remote host of your account. You use it from the desktop app,
the iPhone app or `openbot.run/app`, as you use a [hosted server](hosted-servers.md). You install
and control it from a terminal.

To run it in a container, see [Docker](docker.md).

## Install

On Ubuntu 24.04 or 26.04 (x86_64 or arm64) with systemd:

```sh
curl -fsSL https://raw.githubusercontent.com/nightly-labs/openbot/main/scripts/install-server.sh | sudo bash
sudo openbot login
```

`openbot login` asks for your email and the code that OpenBot sends to it. After the sign-in, the
server shows in the server list of that account. Its name is "OpenBot"; give another one with
`sudo openbot login --name <name>` or `sudo openbot name <name>`. A name has 6 to 32 characters.
Then connect a provider from the app, as on a hosted server (see
[Providers](hosted-servers.md#providers)).

### Sign in with a server claim

An operator who sets up a server for somebody else can sign it in with no code. The operator makes a
one-time claim for the owner's email, and the server redeems it. The owner does nothing: when they
sign in to OpenBot with that email, the server is in their server list.

```sh
printf '{"email":"%s"}' owner@example.com |
  curl --fail -sS -X POST https://api.openbot.run/v2/admin/server-claims \
    -H @server-claims.header -H 'content-type: application/json' --data-binary @- |
  sed -n 's/.*"claim":"\([A-Za-z0-9_-]*\)".*/\1/p' |
  sudo openbot login --claim --name <name>
```

`server-claims.header` holds one line, `Authorization: Bearer <token>`, so the token is in no process
argument. `openbot login --claim` reads the claim from standard input, or asks for it without an echo
in a terminal, for the same reason.

- `POST /v2/admin/server-claims` needs the `SERVER_CLAIMS_ADMIN_TOKEN` of the account service. It
  makes the account of the email when there is none, and answers `{"claim", "expiresAt"}`.
- The claim works once, for 15 minutes. The account service keeps only its hash.
- The server sends it to `POST /v2/server-claims/redeem` and gets a session of the owner. The owner
  is then the only owner of the server. The operator does not need the owner's email or password.
- A claim that was used, or that expired, gives `server_claim_invalid`. If the server did not get the
  answer, make a new claim.

Anyone with the admin token can get a session for any email, also of an existing account. Keep the
token on the operator's computer only. The owner sees each claimed server session in their account
sessions, and can revoke it there.

Install options go after `sudo bash -s --`:

| Option | Default | Use |
| --- | --- | --- |
| `--user <name>` | the installed user, else `openbot` | The user that runs OpenBot and its agents. The install makes it when it does not exist, with its home folder in `/var/lib/<name>`. |
| `--auth-api-url <origin>` | the installed one, else the URL in the build | Another account server, for example the `test` Worker or a [self-hosted account service](self-hosting.md). |
| `--display-size <W>x<H>` | the installed one, else `1280x800` | The size of the virtual display that computer use reads (see [Display size](#display-size)). |

Run the install again to reinstall or upgrade. The data stays in the home folder of the service
user. A reinstall keeps the user and the account server, because the sign-in belongs to them, and
refuses another `--user`. A reinstall without `--display-size` keeps the display size. The install refuses an older release than the installed one, because an older OpenBot cannot
open a database that a newer one migrated. It also refuses a computer that is a hosted server.

## Commands

| Command | Use |
| --- | --- |
| `openbot status [--raw]` | Show the version, the account, the server state, how the server runs (health, agents, database version, restart safety, providers, memory, turns) and a staged update. `--raw` prints the `key=value` lines for scripts. |
| `openbot health` | Exit 0 when OpenBot works, 1 when it does not. |
| `openbot backup <file>` | Write a verified copy of the database to a new file, while OpenBot runs. See [Backup](docker.md#backup-and-upgrade-rehearsal). |
| `openbot diagnostics [<file>]` | Show the sanitized diagnostics report, or save it to a new file. |
| `openbot analytics [on\|off]` | Show or change product analytics on this server. |
| `openbot login [<email>] [--name <name>]` | Sign in with an email code. |
| `openbot login --claim [--name <name>]` | Sign in with an operator's one-time claim (see [Sign in with a server claim](#sign-in-with-a-server-claim)). |
| `openbot mobile-connect` | Show a Mobile Connect QR code for the phone app (see [Phone app](#phone-app)). |
| `openbot logout` | Sign out. The server is not available until the next sign-in. |
| `openbot name <name>` | Change the server name. |
| `openbot audit [count]` | Show the newest security changes: who changed an event check, an app connection, auto-approve or another agent. Names only, never values. |
| `openbot logs [-f]` | Show the journal of `openbot.service`. |
| `sudo openbot start\|stop\|restart` | Control `openbot.service`. |
| `sudo openbot update` | Download, check and install the newest release now. |
| `sudo openbot uninstall` | Sign out and remove OpenBot. The data stays (see [Remove](#remove)). |
| `openbot version` | Show the installed version. |

Run the account commands with `sudo` or as the service user. Other users cannot open the control
socket.

## Memory

A self-hosted server uses the memory guards of a hosted server (see
[Memory](hosted-servers.md#memory)). When free memory is low, new turns wait in the queue and start
again when memory is available. A message from a person starts first. The browser opens no new tab
and unloads idle pages sooner. A fixed number of turns run at the same time: 2 up to 5 GiB of memory,
8 up to 10 GiB, 12 up to 40 GiB, and 24 above.

The memory ceiling is the smaller of the machine memory and the limit of `openbot.service`
(`MemoryMax=90%`). To give OpenBot less memory, lower the limit with
`sudo systemctl edit openbot.service`, for example `MemoryMax=2G`, and restart the service. The
turn limit and the low-memory levels then use the new ceiling. `openbot status` shows the ceiling,
the free memory, the level (`ok`, `low` or `critical`) and the turn limit:

```text
Memory: 1228 MiB free of 3481 MiB (ok)
Turns at the same time: at most 2
```

The guard reads cgroup v2. On a system with cgroup v1, it uses the machine memory and the log has
one warning.

Agent processes run at nice 10 with an OOM value of 500, also a job that an agent detaches. At the
`critical` level, OpenBot stops leftover agent processes first. Node programs of agents see the CPU
limit of the unit in `os.cpus()`. See [agent processes](hosted-servers.md#memory).

## Display size

A self-hosted server gives the agents a virtual display (Xvfb), and computer use reads that display.
The default size is 1280x800. A [Docker](docker.md#environment) container uses the same setting
and the same default. A hosted server gives the agents its boat desktop, and this setting does not
change that desktop.

The display size does not change the OpenBot browser (`openbot_browser`). Its pages have their own
size, 1200x800 when no panel shows them, and its clicks go to page elements.

To use another size, give it at the install with `--display-size 1920x1080`, or write this line in
`/opt/OpenBot/hosted/openbot.env` and run `sudo openbot restart`:

```text
OPENBOT_DISPLAY_SIZE=1920x1080
```

The value is `WIDTHxHEIGHT` in digits, from 640x480 to 2576x2576. The install refuses a value that is
not valid. At a start, a value that is not valid writes this warning in `openbot logs`, and the
server starts with 1280x800:

```text
OPENBOT_DISPLAY_SIZE is not WIDTHxHEIGHT from 640x480 to 2576x2576. The display is 1280x800.
```

### Which size to use

Keep 1280x800 unless the apps that agents use need more space. At 1280x800, computer use clicks
more accurately, and a screenshot costs fewer tokens. Use 1920x1080 only with a model that reads a
1920x1080 image at its full size (see [Screenshots and clicks](#screenshots-and-clicks)).

A click test compared the two sizes. A model clicked a 26x17 px button in an `xmessage` window that
almost filled the display, once from a full-display screenshot and once from a window screenshot.
The models were the free OpenCode models with image input (OpenCode 1.18.30, Docker image 0.42.0,
arm64):

| Model | 1920x1080, full display | 1920x1080, window | 1280x800, full display | 1280x800, window |
| --- | --- | --- | --- | --- |
| MiMo v2.6 Flash | Hit | Miss | Hit | Hit |
| DeepSeek v4.1 Flash | Miss | Miss | Hit | Hit |
| GLM 5.3 Flash | Hit | Miss | Hit | Not tested (429) |
| LongCat 2.5 Preview | Miss | Miss | Hit | Hit |
| Muse Spark 1.3 | Miss | Miss | Miss | Hit |
| Nemotron 3.5 Super VL | Miss | Miss | Hit | Hit |
| Space Bunny | Hit | Hit | Hit | Hit |
| **Hits** | **3 of 7** | **1 of 7** | **6 of 7** | **6 of 6** |

Claude and Codex models were not in the test.

An image costs `⌈width / 28⌉ × ⌈height / 28⌉` visual tokens on Claude. A full-display screenshot at
1920x1080 costs about 2 times the tokens of one at 1280x800:

| Display size | Visual tokens of one full-display screenshot |
| --- | --- |
| 1280x720 | 1196 |
| 1280x800 | 1334 |
| 1366x768 | 1372 |
| 1920x1080 | 2691 |
| 2560x1440 | 4784 |

### Screenshots and clicks

The computer use driver (cua-driver, `cua-driver-rs-v0.34.0`) has two screenshots on Linux:

- **One window** (`get_window_state`). The driver makes the image 1.15 megapixels or less, with a long
  edge of 1568 px or less, and changes the x and y of each click back to screen pixels. A 1260x780
  window gets to the model at its full size. A 1900x1060 window gets to the model at 1435x801. Then
  small controls are harder to hit, and some models send the x and y in screen pixels, so the click
  lands outside the control. A window that goes past the edge of the display gives no screenshot.
- **The full display** (`get_desktop_state`). The driver sends the image at its full size and uses
  the x and y of a click as screen pixels. The clicks land correctly only when the model reads the
  image at its full size.

What a model reads of a full-display screenshot at 1920x1080:

| Provider | Image |
| --- | --- |
| Claude 4.7 and later, all Claude 5 models | Full size, up to 2576 px on the long edge and 4784 visual tokens ([Vision](https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost)) |
| Codex | Full size: the limit is 2048 px and 2,500 tiles of 32x32 px, and 1920x1080 is 2,040 tiles |
| Grok, Gemini, OpenCode, Cursor, Cline, Pi | Not known |

A 1280x800 screenshot is not made smaller by any Claude or Codex model.

## Phone app

The phone app has no email sign-in. It signs in with a Mobile Connect code. A server has no screen
for the code, so `openbot mobile-connect` shows it in the terminal:

1. Sign in the server with `openbot login`.
2. Run `openbot mobile-connect`. In a container, run `docker exec -it <container> openbot mobile-connect`.
3. In the phone app, select **Scan QR code** and scan the code in the terminal.

The code signs the phone in to the account of the server. It works for one sign-in and expires after
two minutes. The phone then shows all servers of the account, and it opens this server first. The
phone connects through the account server and Signal, as the desktop app does. The server publishes
no port.

If the phone app is already connected to the same account from the desktop app, the server is
already in its server list. Remove a phone from the account in the desktop app, in
**Settings > Mobile Connect**.

## Remove

`sudo openbot uninstall` signs out, then removes the service, the units, the AppArmor profile, the
`openbot` command and the server files in `/opt/OpenBot`. It keeps the home folder of the service user
and the keyring in `/srv/openbot-hosted`. The keyring has the key of the encrypted data in that home
folder, so keep or delete the two together. An install with the same `--user` uses them again. To
delete the data too:

```sh
sudo userdel --remove openbot && sudo rm -rf /srv/openbot-hosted
```

The server stays in the server list of the account, offline. Remove it there.

## How it works

`install-server.sh` only downloads the release. It reads `latest-linux.yml`
(`latest-linux-arm64.yml` on arm64) of the latest GitHub release, checks the SHA-512 of the
AppImage, unpacks it and runs `resources/hosting/openbot-server-setup` from that release. So the
install steps always match the build that they install. A release before this feature has no setup
file, and the install stops with a message.

`openbot-server-setup` uses the install steps of a hosted server (`openbot-hosted-update`): it
installs the packages in `packages.txt`, copies the release to `/opt/OpenBot/app`, and installs the
scripts, the AppArmor profile and the units. It writes `self` to `/opt/OpenBot/hosted/mode` and
links `/usr/local/bin/openbot`.

With `mode` set to `self`, `openbot-hosted-server` does not wait for a claim or for a boat desktop.
It starts a D-Bus session with an unlocked keyring, as on a hosted server, and runs OpenBot under
Xvfb with `OPENBOT_SERVER=1`. Main (`src/main/server-mode.ts`) then opens the control socket
`/run/openbot/control.sock` and publishes the host after each sign-in.

### Who may use the control socket

Agents run as the service user, so the mode of the socket and its folder does not keep them out.
Main asks the kernel which process connected (`SO_PEERCRED` and `SO_PEERPIDFD`, read by a small Perl
helper in `src/main/control-socket-peer.ts`) and walks that process's parents:

- A process that descends from main is an agent. So is an orphan that PID 1 adopted and that is
  still in the service's cgroup (a double fork does not get an agent out).
- A process whose chain starts outside the PID namespace (`docker exec`), or that runs in another
  cgroup (an operator's login shell, `sudo -u openbot openbot …`), is an operator.
- When the helper cannot tell, the caller counts as an agent.

`GET /v1/status` and `GET /v1/health` answer anyone, so the health check and `openbot status`
work everywhere. Every other route answers an agent with `403` and `error=operator_only`: sign-in,
sign-out, the server name, Mobile Connect, backup, analytics, the audit rows, diagnostics, the
spaces routes, the debug routes, `POST /v1/agents/<id>/message` and `POST /v1/resume-interrupted`.

Operators need no token. Run the request from outside the service, as before:

```sh
sudo docker exec -i openbot openbot backup /data/backups/openbot.db
printf '%s' '{"system":true,"text":"Continue."}' | sudo docker exec -i openbot \
  curl -s --unix-socket /run/openbot/control.sock -H 'content-type: application/json' \
  --data-binary @- http://openbot/v1/agents/<agentId>/message
```

The backfill of the Motion human views ([Human view of Motion content](motion-human-view.md)) is an
operator route too:

```sh
printf '%s' '{"workspaceName":"Universidad Online","days":7}' | sudo docker exec -i openbot \
  curl -s --unix-socket /run/openbot/control.sock -H 'content-type: application/json' \
  --data-binary @- http://openbot/v1/motion/human-backfill
sudo docker exec openbot curl -s --unix-socket /run/openbot/control.sock http://openbot/v1/motion/human-backfill
```

The check is not a jail: an agent still runs as the service user. The [agent jail](#agent-jail) keeps
a jailed agent out of that user's other files.

### Agent jail

Agents run as the same user as OpenBot, in the same container. On a Linux server, each Claude agent's
provider process runs in a jail of its own (`src/backend/agent-jail.ts`). Main starts the CLI through
`resources/agent-runtime/agent-jail.py`, which restricts itself with Landlock and then starts the
CLI, so the CLI and everything it starts keep the jail: the Bash tool, the stdio MCP servers, the
Computer Use driver's proxy, git, Node, Python and the build tools. Nothing inside can take it away.
Landlock needs no privilege and no namespace: Docker's own AppArmor profile refuses the mounts that
bubblewrap needs, and with AppArmor off, Ubuntu refuses user namespaces to an unconfined process.

The jail reaches:

- the system folders (`/usr`, `/etc`, `/opt` and the others), `/proc` and `/sys`, to read and run,
  and `/dev`, `/tmp`, `/var/tmp` and `/dev/shm`;
- the agent's workspace, the shared folder of its space, the browser downloads (`~/OpenBot/Downloads`),
  the old default of `appctl deploy --src` (`~/OpenBot/Shared/apps`), and the CLI's config folder
  with its sign-in and sessions (`CLAUDE_CONFIG_DIR`, `~/.claude` for the first account);
- the workspaces of the agent's teammates in the same space, to read only (the list is read when the
  process starts), the agent's own key folder and the shared keys, the provider runtimes, the GitHub connection's
  folder, and the files that main writes for one start: the MCP config, the settings file and the
  skill plugins, with the folders their links point at, and the folder of each MCP server program;
- a home folder of the agent's own, `<profile>/agent-jail/<agent>/home`, which `HOME` names. Each
  entry of the real home links there, except the ones that hold sign-ins, keys, histories and
  backups (`.ssh`, `.claude.json`, `.codex`, `~/.config/openbot-container` with the keyring password,
  `~/.local/share/keyrings` and the others in `agent-jail.ts`) and the folders with OpenBot's data. So
  `~/.cargo`, `~/.bun`, `~/.cache` and `~/.config/godot` stay shared, and a new file in `~` stays the
  agent's. `TMPDIR` and `XDG_RUNTIME_DIR` are folders of the agent too, emptied at each start of OpenBot.

Everything else is out of reach: the other agents' keys, the workspaces of agents in other spaces
and writes to a teammate's workspace, the other spaces, the
database and the rest of the profile, the provider sign-ins of other providers, the keyring and its
password, the automation token and `/run/openbot`. Landlock also refuses a jailed process the memory,
`environ`, open files and links of any process outside its jail in `/proc`, main's and PID 1's
included, and a signal to such a process. The jail takes `DBUS_SESSION_BUS_ADDRESS`,
`GNOME_KEYRING_CONTROL` and `SSH_AUTH_SOCK` out of the environment. The Claude CLI keeps its global
config in its config folder: the first account gets `CLAUDE_CONFIG_DIR`, and its first jailed start
copies `~/.claude.json` there.

Every provider runs in the jail, the same way: Claude, Codex, OpenCode, Antigravity, Cursor, Cline,
Pi and the key-only providers, Grok, Muse and the custom ACP agents. Claude starts a process for each
session and jails it there; every other provider runs each agent in a process of its own, which
`ProviderRuntime` starts through the launcher, with the provider's own folders (its sign-in, settings
and sessions, such as `~/.codex`) writable and linked into the agent's home. In the jail the
provider's own sandbox is off: Codex runs with `danger-full-access` and Claude without its Workspace
only sandbox, because their sandboxes cannot start in the container and would ask the owner to approve
each command. The jail is the agent's limit, so a command, file or permission approval of a jailed
agent is answered without a card; money stays with the trust gate. `OPENBOT_AGENT_JAIL=off` turns the
jail off. Without Landlock 3 (Linux 6.2) or `python3`, an agent does not start, with a plain message:
no agent runs outside the jail. A start that is not an agent's session, such as a title or a profile
generation, has no tools and runs without the jail. To see which processes are jailed, run
`docker exec openbot sh -c 'grep -l OPENBOT_AGENT_JAILED=1 /proc/[0-9]*/environ'`.
`bun scripts/agent-jail-e2e.ts` checks the jail on a Linux computer, and
`bun scripts/agent-jail-providers-e2e.ts` checks that each provider runtime on the server starts jailed
and that a Codex agent reads a file with no approval card.

What still reaches a jailed agent:

- A UNIX socket file, which Landlock does not control: the control socket (which refuses agents by
  itself, above), the appctl and benchctl sockets (on purpose), the D-Bus socket in `/tmp`, which
  still gives the keyring's secrets to a process that finds it, and the X display of the OpenBot
  window (`:0`), which has no access control.
- `/tmp`, `/dev/shm` and the browser downloads, which all agents share, the names and command lines
  of all processes in `ps`, and the network, with OpenBot's loopback services.
- The sessions and transcripts of the other agents on the same Claude account, in its config folder.
- Another session of the same agent: each process is a jail of its own, so one cannot read the
  `environ` of, or signal, a program that the other started.
- A shell command of Codex with Full access runs without asking, so the money check does not see it.

The money credentials would move into a broker that main runs, which asks the owner and then calls
the payment API, so an agent never holds them.

The server has two Xvfb displays, one in each of two nested `xvfb-run` commands that share one
authority file. The outer one starts the agent display, at the [display size](#display-size), and
the script names it in `OPENBOT_AGENT_DISPLAY`. The inner one starts the display that OpenBot shows
its windows on, at 1280x800. Main gives that display to Computer Use, to remote desktop and to the agent
processes, so an agent's screenshot and remote desktop do not show the OpenBot window. See
[Computer Use and remote desktop](architecture/computer-use.md#agent-display-on-a-server).

Updates work as on a hosted server (see [Updates](hosted-servers.md#updates)): the timer stages a
new release, and it starts at the next boot, or when an owner, an admin or a permitted member
installs it in Server Settings > Updates. `sudo openbot update` stages, stops the service, applies
and starts the service again. When a step fails or a signal stops it, the command completes an
interrupted copy, starts the service, and exits with an error.

## Control socket

The `openbot` command talks to main over HTTP on a Unix socket, with form bodies and `key=value`
text answers, so it needs only `curl`. The routes are `GET /v1/status`, `GET /v1/health`,
`POST /v1/login/start`, `POST /v1/login/verify`, `POST /v1/login/claim`, `POST /v1/name`,
`POST /v1/mobile-connect`, `POST /v1/logout`, `POST /v1/backup`, `GET /v1/diagnostics`,
`POST /v1/analytics`, `POST /v1/drain`, `POST /v1/drain/cancel`, `POST /v1/resume-interrupted`
and `GET /v1/audit?limit=N` (see [restart between turns](docker.md#health-logs-and-diagnostics)). The last one answers with the newest rows of the
security audit file, as `row<N>=<JSON>` lines. `openbot audit [count]` shows them. A row has names
and never a value. The Docker image and the status keys are in
[Docker](docker.md#health-logs-and-diagnostics).

Threat model:

- systemd makes `/run/openbot` for the service user with mode 0700, and main makes the socket 0600.
  Main refuses to listen when the directory belongs to another user or other users can enter it. It
  never removes a file at the socket path that is not a socket.
- Only the service user and root can connect. Agents run as the service user, and the
  [agent jail](#agent-jail) does not control a connection to a socket file, so main also refuses
  every process that descends from it, as above.
- The socket answers a closed list of requests. It never sends the session token, the sign-in
  code or the claim back, and a value cannot add a line to an answer. A body is at most 4 KiB.
- `POST /v1/backup` writes a database copy only when the operator asks. It refuses to replace a file.
  `GET /v1/diagnostics` sends the same sanitized report as **Export diagnostics**. The status lines
  hold numbers, state words and reason codes from a fixed list, and one redacted reason for a failed
  agent start.
- Server mode starts only in a packaged Linux build with `OPENBOT_SERVER=1`, and never on a hosted
  server, which signs in with its claim.

## The session of the server

`openbot login` gives the server a session on the account server. The session never expires when
the account server lists the address of the server as a durable source address
(`AUTH_DURABLE_SOURCE_IPS`), which a private deployment does. Anyone who reads the token from the
server, for example an agent that has full access, would get a lasting owner credential. So the
account server treats a session that never expires and is not a phone as the credential of a server:
it works as the host, and it cannot do what only a person on a device should do.

| The session of a server can | It cannot |
| --- | --- |
| Sign in, sign out, read the account and the profile, set the name and the avatar | Make a Mobile Connect code, or list or end the phones and other sessions of the account |
| Publish and register the host, get its ticket, and send the live activity | Open a remote session to a host (the owner's own client does this), or join a team server |
| Route webhooks, Slack and Discord to the host | Reach billing, hosted servers or their checkout |
| List and make `member` invitations, list members, lower a role, remove a member | Make an `admin` or a permanent invitation, make an admin, or bring back a removed member |

An `admin` invitation or a role change to admin must come from the owner's app or the website, with
the owner's own sign-in. The refusal is `403 host_session_restricted`. The restriction needs no
database change: the account server derives it from the session expiry and the phone table. A
deployment that sets no default session lifetime has no durable class and no restriction. To end a
server's session, sign out with `openbot logout` or end it in the account's sessions list.

## Not confirmed

- The full install runs only on Ubuntu 24.04 in tests. On Debian 12 and Debian 13, only the package
  step is tested (`apt-get --dry-run`). Debian 12 names some libraries without the `t64` suffix, and
  the install uses those names.
- Ubuntu 26.04: release 0.48.1 was tested on Ubuntu 26.04.1 arm64 in the Docker image, with
  `BASE=ubuntu:26.04` and the package list without `libminiupnpc17` (the 0.48.1 list stops that
  build). The server started with the Electron sandbox on, `openbot status` answered, and it stopped
  with exit code 0. The install with systemd and a native x86_64 run were not tested.
- Remote desktop on Ubuntu 26.04: the runtime build checks with `ldd` that the x86_64 runtime finds
  all its libraries there (see [Linux runtime](RELEASING.md#linux-runtime-recipe-16)). In the x86_64
  Docker image under emulation, Sunshine and Moonlight Web started. A streamed remote desktop
  session on Ubuntu 26.04 was not tested.
- The full install was not run on a Linux computer before the first release that has the setup
  file. It needs a release build.
- [Display size](#display-size): the display sizes, the warning and the start with a value that is
  not valid were tested in the Docker image. An install with `--display-size` was not run. The click
  test ran only on arm64, with one `xmessage` button and one run for each model, size and screenshot.
  Claude and Codex were not in it. A window past the edge of the display was tested only with
  `xmessage`. The window screenshot limits come from the cua-driver source
  (`platform-linux/src/tools/impl_.rs`, `get_window_state` and `get_desktop_state`), and the Claude
  limits from the Claude docs. The Codex limit comes from `codex-rs/utils/image` and was not checked
  again. It is not known if Claude Code or Codex makes a screenshot smaller before it sends it to
  the model.
- The two displays were tested in an Ubuntu 24.04 container with a stand-in for OpenBot: OpenBot
  gets 1280x800, the agent display the display size, and a process without the authority file cannot
  open the agent display. Computer Use and remote desktop on the agent display were not tested on a
  server.
